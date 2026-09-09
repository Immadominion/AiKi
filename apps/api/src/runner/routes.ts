import type { FastifyInstance } from 'fastify'
import { type Address, createPublicClient, http, type PublicClient, parseAbi } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'
import { requireOwner, requireSession } from '../auth/guard.js'
import type { WatchMandateVerifier } from '../authority/watch-readiness.js'
import { unresolvedExecutionMessage } from '../execution/attempts.js'
import { ClientError } from '../http/errors.js'
import type { JobService } from '../jobs/service.js'
import { VenusClient, type VenusReader } from '../reference/venus/client.js'
import type { Watch, WatchStore } from './store.js'
import { headroom } from './sweep.js'

/**
 * Starting, reading and stopping a watch.
 *
 * A watch is the only thing in this system that causes money to move without a
 * person present, so the refusals here matter more than the happy path. Each one
 * is checked before the row is written rather than at sweep time, because a
 * watch that is accepted and then silently never runs is worse than one that was
 * refused with a reason: the user believes a guardian is on duty.
 */

export interface WatchRoutesConfig {
  jobs: JobService
  watches: WatchStore
  activation?: WatchActivationReader
}

export interface WatchActivationReader extends VenusReader {
  chainId: number
  /** Public address derived from this deployment's validated execution key. */
  executorAddress?: Address
  verifyMandate?: WatchMandateVerifier
  underlying(market: Address): Promise<Address>
}

/** Read readiness on the same network the unattended executor can act on. */
export function createWatchActivationReader(
  rpcUrl: string,
  suppliedClient?: PublicClient,
  chainId = 56,
  executorAddress?: Address,
  verifyMandate?: WatchMandateVerifier,
): WatchActivationReader {
  if (chainId !== 56 && chainId !== 97) throw new Error('Unsupported watch execution network.')
  const client =
    suppliedClient ??
    createPublicClient({
      chain: chainId === 56 ? bsc : bscTestnet,
      transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }),
    })
  const venus = new VenusClient(rpcUrl, client, chainId)
  const assertChain = async () => {
    if ((await client.getChainId()) !== chainId)
      throw new Error('The watch RPC is not connected to the execution network.')
  }
  return {
    chainId,
    ...(executorAddress ? { executorAddress } : {}),
    ...(verifyMandate ? { verifyMandate } : {}),
    async snapshot(account) {
      await assertChain()
      return venus.snapshot(account)
    },
    async underlying(market) {
      await assertChain()
      return client.readContract({
        address: market,
        abi: parseAbi(['function underlying() view returns (address)']),
        functionName: 'underlying',
      })
    },
  }
}

interface StartBody {
  account?: string
  chainId?: number
  minimumHealthFactor?: string
  asset?: string
  market?: string
}

/** repayBorrow(uint256), the one call a guardian's standing authority covers. */
const REPAY_BORROW = '0x0e752702'

const address = (value: string | undefined, name: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new ClientError(`${name} must be a 0x-prefixed 20-byte address.`, {
      code: 'WATCH_MALFORMED',
    })
  return value.toLowerCase()
}

/**
 * The line the agent defends.
 *
 * Bounded on both sides. Below 1.0 the position is already liquidatable and the
 * agent would be chasing a target it can never reach; absurdly high and every
 * pass tries to repay the entire debt, which is a rounding error away from
 * asking the mandate to spend everything it has on the first tick.
 */
export function parseMinimumHealthFactor(value: string | undefined): string {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,18})?$/.test(value))
    throw new ClientError('Minimum health factor must be a decimal like "1.25".', {
      code: 'WATCH_MALFORMED',
    })
  const asNumber = Number(value)
  if (asNumber < 1 || asNumber > 10)
    throw new ClientError('Minimum health factor must be between 1 and 10.', {
      code: 'WATCH_MALFORMED',
    })
  return value
}

export function registerWatchRoutes(app: FastifyInstance, config: WatchRoutesConfig) {
  const { jobs, watches } = config

  app.post<{ Params: { id: string }; Body: StartBody }>(
    '/v1/jobs/:id/watch',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply

      const job = await jobs.getJob(request.params.id)
      const authorization = await jobs.getAuthorization(job.authorizationId)
      if (!requireOwner(request, reply, session, authorization.owner, 'job')) return reply
      const pending = await jobs.pendingExecution(authorization.id)
      if (pending)
        throw new ClientError(unresolvedExecutionMessage(pending), {
          code: 'WATCH_EXECUTION_UNCONFIRMED',
          statusCode: 409,
        })

      const body = request.body ?? {}
      const chainId = body.chainId ?? config.activation?.chainId ?? authorization.delegationChainId
      if (
        (chainId !== 56 && chainId !== 97) ||
        (config.activation && chainId !== config.activation.chainId)
      )
        throw new ClientError('The selected network is not configured for automatic repayment.', {
          code: 'WATCH_UNSUPPORTED_CHAIN',
        })

      /*
       * The two refusals that make an unattended loop defensible at all.
       *
       * Without a signature, the only thing standing between an agent's bug and
       * the user's balance is AiKi's own bookkeeping, and AiKi asking itself for
       * permission is not a control. Without a lifetime cap there is no bound on
       * what a loop can spend before anybody notices.
       */
      if (!authorization.delegation)
        throw new ClientError(
          'This mandate has not been signed, so nothing on chain would limit an agent acting on its own. Sign it first.',
          { code: 'WATCH_UNSIGNED', statusCode: 409 },
        )
      if (headroom(authorization) === null)
        throw new ClientError(
          'A watch needs a total spending limit, so there is a bound on what it can spend while you are away.',
          { code: 'WATCH_UNCAPPED', statusCode: 409 },
        )
      if (authorization.delegationChainId !== chainId)
        throw new ClientError('The signed mandate belongs to a different execution network.', {
          code: 'WATCH_CHAIN_MISMATCH',
          statusCode: 409,
        })
      const account = address(body.account, 'Account')
      if (account !== authorization.delegation.delegator.toLowerCase())
        throw new ClientError('Watch the account covered by this signed mandate.', {
          code: 'WATCH_ACCOUNT_MISMATCH',
          statusCode: 409,
        })

      /*
       * A mandate that does not permit repaying is a watch that would be refused
       * by the chain on every single pass, forever, and look from the outside
       * like an agent that simply never does anything. Better to say so now,
       * while the person is here to widen the mandate.
       */
      const market = address(body.market, 'Market')
      const permits = (kind: 'selector_allowlist' | 'contract_allowlist', value: string) => {
        const constraint = authorization.policy.constraints.find((c) => c.kind === kind)
        if (!constraint) return true
        const list = Array.isArray(constraint.value) ? constraint.value.map(String) : []
        return list.some((entry) => entry.toLowerCase() === value)
      }
      if (!permits('selector_allowlist', REPAY_BORROW))
        throw new ClientError(
          'This mandate does not allow repaying a loan, so every attempt would be refused on chain.',
          { code: 'WATCH_SELECTOR_NOT_ALLOWED', statusCode: 409 },
        )
      if (!permits('contract_allowlist', market))
        throw new ClientError(
          'This mandate does not allow acting on that market, so every attempt would be refused on chain.',
          { code: 'WATCH_TARGET_NOT_ALLOWED', statusCode: 409 },
        )

      const asset = address(body.asset, 'Asset')
      const minimumHealthFactor = parseMinimumHealthFactor(body.minimumHealthFactor ?? '1.25')
      const existing = await watches.get(job.id)
      if (existing)
        throw new ClientError('That job is already being watched.', {
          code: 'WATCH_EXISTS',
          statusCode: 409,
        })
      const reader = config.activation
      if (!reader || reader.chainId !== chainId || !reader.executorAddress || !reader.verifyMandate)
        throw new ClientError('Automatic repayment is not configured on this deployment.', {
          code: 'WATCH_UNAVAILABLE',
          statusCode: 503,
        })
      if (authorization.delegation.delegate.toLowerCase() !== reader.executorAddress.toLowerCase())
        throw new ClientError(
          'This mandate names a different executor. Sign a new mandate before starting a watch.',
          {
            code: 'WATCH_EXECUTOR_MISMATCH',
            statusCode: 409,
          },
        )
      try {
        const readiness = await reader.verifyMandate(authorization)
        if (!readiness.ready)
          throw new ClientError(readiness.reason, {
            code: 'WATCH_MANDATE_NOT_READY',
            statusCode: readiness.retryable ? 503 : 409,
          })
      } catch (error) {
        if (error instanceof ClientError) throw error
        throw new ClientError('The signed mandate could not be verified. No watch was started.', {
          code: 'WATCH_MANDATE_NOT_READY',
          statusCode: 503,
        })
      }
      try {
        const snapshot = await reader.snapshot(account as Address)
        if (snapshot.account.toLowerCase() !== account)
          throw new ClientError('The position read does not belong to the signed account.', {
            code: 'WATCH_ACCOUNT_MISMATCH',
            statusCode: 409,
          })
        const position = snapshot.markets.find((item) => item.vToken.toLowerCase() === market)
        if (!position || position.borrowBalance <= 0n)
          throw new ClientError('This account has no debt in the selected Venus market to repay.', {
            code: 'WATCH_NO_DEBT',
            statusCode: 409,
          })
        const underlying = await reader.underlying(market as Address)
        if (underlying.toLowerCase() !== asset)
          throw new ClientError('The repayment asset does not match this Venus market.', {
            code: 'WATCH_ASSET_MISMATCH',
            statusCode: 409,
          })
      } catch (error) {
        if (error instanceof ClientError) throw error
        throw new ClientError('The Venus position could not be verified. No watch was started.', {
          code: 'WATCH_POSITION_UNAVAILABLE',
          statusCode: 503,
        })
      }

      const watch: Watch = {
        jobId: job.id,
        authorizationId: job.authorizationId,
        account,
        chainId,
        protocol: 'venus',
        minimumHealthFactor,
        asset,
        market,
        status: 'active',
        createdAt: new Date().toISOString(),
      }

      const created = await watches.create(watch)
      await jobs.record(job.id, {
        type: 'status',
        detail: `watch started: keeping health factor at or above ${created.minimumHealthFactor}`,
      })
      return reply.code(201).send(created)
    },
  )

  app.get<{ Params: { id: string } }>('/v1/jobs/:id/watch', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const job = await jobs.getJob(request.params.id)
    const authorization = await jobs.getAuthorization(job.authorizationId)
    if (!requireOwner(request, reply, session, authorization.owner, 'job')) return reply

    const watch = await watches.get(job.id)
    if (!watch)
      return reply.code(404).send({ error: { code: 'WATCH_NOT_FOUND', message: 'Not watched.' } })
    return {
      ...watch,
      // What is left to spend, so the page can say it without doing the
      // arithmetic itself and getting a different answer.
      remaining: headroom(authorization)?.toString() ?? null,
    }
  })

  app.post<{ Params: { id: string } }>('/v1/jobs/:id/watch/stop', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const job = await jobs.getJob(request.params.id)
    const authorization = await jobs.getAuthorization(job.authorizationId)
    if (!requireOwner(request, reply, session, authorization.owner, 'job')) return reply

    await watches.stop(job.id)
    await jobs.record(job.id, { type: 'status', detail: 'watch stopped by the owner' })
    return watches.get(job.id)
  })
}
