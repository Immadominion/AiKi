import type { Address } from 'viem'
import type { WatchMandateVerifier } from '../authority/watch-readiness.js'
import { executorAddress } from '../config/executor-identity.js'
import { unresolvedExecutionMessage } from '../execution/attempts.js'
import type { SignedDelegation } from '../execution/executor.js'
import type { JobService } from '../jobs/service.js'
import type { AuthorizationRecord } from '../jobs/store.js'
import type { VenusReader } from '../reference/venus/client.js'
import { assessVenusSnapshot } from '../reference/venus/client.js'
import { tick } from './runner.js'
import type { Watch, WatchStore } from './store.js'

/**
 * One pass over everything being watched.
 *
 * This is the thing that makes an agent an agent. Everything under it already
 * worked when a person pressed a button; what was missing was anything that
 * presses the button at 3am, which is the entire reason somebody would hire a
 * guardian rather than set a price alert.
 *
 * A pass never throws. One unreachable RPC, one mandate that turns out to be
 * revoked, one position the reader cannot parse - none of those may stop the
 * other watches from being looked at, because a runner that dies on the first
 * bad row stops being a runner. Each watch's failure is recorded against that
 * watch and the sweep moves on.
 */

export interface SweepChainConfig {
  rpcUrl: string
  chainId: number
  delegationManager: Address
  /** The agent's session key: the delegate, and the only address the manager takes a redemption from. */
  relayerKey: `0x${string}`
}

export interface SweepDeps {
  jobs: JobService
  watches: WatchStore
  /** How to read a position on a given chain. Absent means this deployment cannot see that chain. */
  reader(chainId: number): (VenusReader & { underlying(market: Address): Promise<Address> }) | null
  /** How to send on a given chain. Absent means this deployment cannot act there. */
  chain(chainId: number): SweepChainConfig | null
  /** Confirm the stored signature and account still match this deployment. */
  verifyMandate?: WatchMandateVerifier
  now?: () => number
  /** How stale a look has to be before it is taken again. */
  intervalMs?: number
  limit?: number
}

export interface WatchPass {
  jobId: string
  acted: boolean
  reason: string
  repay?: string
  transactionHash?: string
  stopped?: boolean
}

export interface SweepReport {
  looked: number
  acted: number
  stopped: number
  passes: WatchPass[]
}

const DEFAULT_INTERVAL_MS = 5 * 60_000
const DEFAULT_LIMIT = 50

/**
 * What is left under the mandate's lifetime cap.
 *
 * A mandate with no lifetime cap has no headroom to compute, and an agent given
 * an unbounded budget to act on its own is the one thing this product exists to
 * refuse. Such a watch is stopped rather than run.
 */
export function headroom(authorization: AuthorizationRecord): bigint | null {
  const cap = authorization.policy.constraints.find((c) => c.kind === 'session_total_cap')
  if (!cap) return null
  const total = BigInt(String(cap.value))
  const left = total - authorization.spent
  return left > 0n ? left : 0n
}

export async function sweep(deps: SweepDeps): Promise<SweepReport> {
  const now = deps.now?.() ?? Date.now()
  const claimed = await deps.watches.claimDue(
    new Date(now),
    deps.intervalMs ?? DEFAULT_INTERVAL_MS,
    deps.limit ?? DEFAULT_LIMIT,
  )

  const passes: WatchPass[] = []
  for (const watch of claimed) {
    try {
      passes.push(await pass(deps, watch, now))
    } catch (error) {
      // The catch-all that keeps one bad watch from ending the sweep. It is
      // recorded against the watch, not swallowed: a watch that has been failing
      // for a day must be able to say so.
      const reason = `Could not complete this pass: ${(error as Error).message}`
      await deps.watches.noteChecked(watch.jobId, new Date(now).toISOString(), reason)
      await deps.jobs.record(watch.jobId, { type: 'status', detail: reason }).catch(() => {})
      passes.push({ jobId: watch.jobId, acted: false, reason })
    }
  }

  return {
    looked: passes.length,
    acted: passes.filter((p) => p.acted).length,
    stopped: passes.filter((p) => p.stopped).length,
    passes,
  }
}

async function pass(deps: SweepDeps, watch: Watch, now: number): Promise<WatchPass> {
  const at = new Date(now).toISOString()
  const halt = async (reason: string): Promise<WatchPass> => {
    await deps.watches.stop(watch.jobId)
    await deps.watches.noteChecked(watch.jobId, at, reason)
    await deps.jobs.record(watch.jobId, { type: 'status', detail: `watch stopped: ${reason}` })
    return { jobId: watch.jobId, acted: false, reason, stopped: true }
  }

  const authorization = await deps.jobs.getAuthorization(watch.authorizationId)

  // A revoked mandate is the user saying stop. Continuing to look would be
  // harmless and continuing to run would not, and a watch left active against a
  // dead mandate is a sweep that fails forever for a reason nobody can see.
  if (authorization.status !== 'active') return halt(`the mandate is ${authorization.status}`)

  if (authorization.policy.expiresAt && Date.parse(authorization.policy.expiresAt) <= now)
    return halt('the mandate has expired')

  // Stopping a revoked or expired watch above does not resolve its transaction
  // or release any held limit. A live mandate may wait for an in-flight action.
  const pending = await deps.jobs.pendingExecution(watch.authorizationId)
  if (pending)
    return pending.state === 'UNCONFIRMED'
      ? halt(unresolvedExecutionMessage(pending))
      : note(deps, watch, at, unresolvedExecutionMessage(pending))

  /*
   * No signature, no unattended action. An unsigned mandate is a real mandate
   * and AiKi will honour it for an action a person asked for, but nothing here
   * asked: this loop acts while the user is asleep. The only thing that makes
   * that defensible is that the chain, not AiKi, is holding the limit.
   */
  const delegation = authorization.delegation as SignedDelegation | undefined
  if (!delegation) return halt('the mandate was never signed, so nothing on chain limits it')
  if (authorization.delegationChainId !== watch.chainId)
    return halt('the watch and signed mandate belong to different networks')
  if (delegation.delegator.toLowerCase() !== watch.account.toLowerCase())
    return halt('the watched account is not covered by the signed mandate')

  const left = headroom(authorization)
  if (left === null) return halt('the mandate has no lifetime cap to spend against')

  const reader = deps.reader(watch.chainId)
  const chain = deps.chain(watch.chainId)
  if (!reader || !chain)
    // Not a halt: a deployment that cannot reach a chain today may reach it
    // tomorrow, and stopping the watch would lose the user's instruction over
    // what is probably a missing environment variable.
    return note(deps, watch, at, `AiKi cannot reach chain ${watch.chainId} at the moment.`)
  if (chain.chainId !== watch.chainId)
    return halt('the executor is configured for a different network')
  if (delegation.delegate.toLowerCase() !== executorAddress(chain.relayerKey).toLowerCase())
    return halt(
      'the signed mandate names a different executor; sign a new mandate before restarting',
    )

  if (!deps.verifyMandate)
    return note(deps, watch, at, 'Signed mandate verification is unavailable. No action was taken.')
  try {
    const readiness = await deps.verifyMandate(authorization)
    if (!readiness.ready)
      return readiness.retryable ? note(deps, watch, at, readiness.reason) : halt(readiness.reason)
  } catch {
    return note(deps, watch, at, 'The signed mandate could not be verified. No action was taken.')
  }

  const snapshot = await reader.snapshot(watch.account as Address)
  if (snapshot.account.toLowerCase() !== watch.account.toLowerCase())
    return halt('the position read belongs to a different account')
  const assessment = assessVenusSnapshot(snapshot, watch.minimumHealthFactor)

  /*
   * The price of the thing being repaid, so the shortfall can be stated in the
   * token the mandate is denominated in rather than in dollars. Taken from the
   * same snapshot the assessment was derived from, so the two cannot be read a
   * block apart and disagree.
   */
  const position = snapshot.markets.find(
    (m) => m.vToken.toLowerCase() === watch.market.toLowerCase(),
  )
  if (!position)
    // Not a halt: entering a market is something the owner can still do, and
    // throwing the instruction away because it is not true yet would be rude.
    return note(deps, watch, at, 'That account holds no position in the market being watched.')
  if (position.borrowBalance <= 0n)
    return note(deps, watch, at, 'There is no debt in this market to repay.')
  if (
    (await reader.underlying(watch.market as Address)).toLowerCase() !== watch.asset.toLowerCase()
  )
    return halt('the repayment asset does not match the Venus market')

  const result = await tick({
    jobs: deps.jobs,
    jobId: watch.jobId,
    assessment,
    state: {
      remaining: left,
      price: position.underlyingPrice,
      ...(watch.lastActedAt ? { lastActedAt: watch.lastActedAt } : {}),
    },
    asset: watch.asset as Address,
    market: watch.market as Address,
    chain,
    delegation,
    now: () => now,
  })
  if (result.needsReview) {
    const stopped = await halt(
      `${result.reason}${result.transactionHash ? ` Transaction: ${result.transactionHash}.` : ''}`,
    )
    return {
      ...stopped,
      ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
    }
  }

  await deps.watches.noteChecked(
    watch.jobId,
    at,
    result.reason,
    // Only stamped when it acted, so the cooldown measures from the last real
    // repayment rather than from the last time anybody looked.
    result.acted ? at : undefined,
  )
  await deps.jobs.record(watch.jobId, {
    type: result.acted ? 'spend' : 'status',
    detail: result.acted
      ? // The hash belongs in the record. It is the only part of this a user can
        // check without trusting us, and a repayment nobody can look up is a
        // claim rather than a receipt.
        `watch repaid ${result.repay?.toString()} on chain: ${result.transactionHash}`
      : `watch looked: ${result.reason}`,
  })

  return {
    jobId: watch.jobId,
    acted: result.acted,
    reason: result.reason,
    ...(result.repay !== undefined ? { repay: result.repay.toString() } : {}),
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  }
}

async function note(deps: SweepDeps, watch: Watch, at: string, reason: string): Promise<WatchPass> {
  await deps.watches.noteChecked(watch.jobId, at, reason)
  return { jobId: watch.jobId, acted: false, reason }
}
