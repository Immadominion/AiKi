import type { FastifyInstance } from 'fastify'
import { requireOwner, requireSession } from '../auth/guard.js'
import { ClientError } from '../http/errors.js'
import type { JobService } from '../jobs/service.js'
import { VENUS_DEPLOYMENTS } from '../reference/venus/client.js'
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

      const body = request.body ?? {}
      const chainId = Number(body.chainId ?? 97)
      if (!VENUS_DEPLOYMENTS.has(chainId))
        throw new ClientError(`AiKi cannot read Venus positions on chain ${chainId}.`, {
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

      const watch: Watch = {
        jobId: job.id,
        authorizationId: job.authorizationId,
        account: address(body.account, 'Account'),
        chainId,
        protocol: 'venus',
        minimumHealthFactor: parseMinimumHealthFactor(body.minimumHealthFactor ?? '1.25'),
        asset: address(body.asset, 'Asset'),
        market,
        status: 'active',
        createdAt: new Date().toISOString(),
      }

      const existing = await watches.get(job.id)
      if (existing)
        throw new ClientError('That job is already being watched.', {
          code: 'WATCH_EXISTS',
          statusCode: 409,
        })

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
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not watched.' } })
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
