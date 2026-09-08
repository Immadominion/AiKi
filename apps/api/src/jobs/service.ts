import { randomUUID } from 'node:crypto'
import type { SignedDelegation } from '@aiki/contracts'
import {
  type Action,
  type Constraint,
  compilePolicy,
  evaluatePolicy,
  evaluatePurchase,
  needsApproval,
} from '../authority/policy.js'
import { ClientError } from '../http/errors.js'
import {
  type AuthorizationRecord,
  InMemoryJobStore,
  type JobEvent,
  type JobRecord,
  type JobStatus,
  type JobStore,
} from './store.js'

export type {
  AuthorizationRecord,
  AuthorizationStatus,
  JobEvent,
  JobRecord,
  JobStatus,
} from './store.js'

/**
 * Mandates and the work done under them.
 *
 * The service owns policy; the store owns durability and atomicity. Everything
 * is async because the real store is a database: a mandate that vanishes when
 * the process restarts is not a mandate, it is a session.
 */
export class JobService {
  private readonly store: JobStore

  constructor(store: JobStore = new InMemoryJobStore()) {
    this.store = store
  }

  async authorize(constraints: Constraint[], owner: string | null): Promise<AuthorizationRecord> {
    const record: AuthorizationRecord = {
      id: randomUUID(),
      policy: compilePolicy(constraints),
      status: 'active',
      spent: 0n,
      createdAt: new Date().toISOString(),
      owner: owner ? owner.toLowerCase() : null,
    }
    return this.store.createAuthorization(record)
  }

  /**
   * File a signed delegation against a mandate that already exists.
   *
   * The checks live in `acceptDelegation` and this is the only path to the
   * store's `attachDelegation`, so there is no way to write a delegation that
   * did not pass them.
   */
  async attachDelegation(
    id: string,
    accepted: { delegation: SignedDelegation; chainId: number },
  ): Promise<AuthorizationRecord> {
    const record = await this.store.attachDelegation(
      id,
      accepted.delegation,
      accepted.delegation.delegator,
      accepted.chainId,
      new Date().toISOString(),
    )
    if (!record) throw new ClientError('No such authorization.', { statusCode: 404 })
    return record
  }

  async revoke(id: string): Promise<AuthorizationRecord> {
    const record = await this.store.revokeAuthorization(id, new Date().toISOString())
    if (!record)
      throw new ClientError('Authorization not found.', { statusCode: 404, code: 'NOT_FOUND' })
    return record
  }

  async createJob(authorizationId: string, idempotencyKey: string): Promise<JobRecord> {
    if (!idempotencyKey) throw new ClientError('Idempotency-Key is required.')
    const existing = await this.store.jobByIdempotencyKey(idempotencyKey)
    if (existing) return existing

    const auth = await this.getAuthorization(authorizationId)
    if (auth.status !== 'active') throw new ClientError(`Authorization is ${auth.status}.`)

    const now = new Date().toISOString()
    const job: JobRecord = {
      id: randomUUID(),
      authorizationId,
      status: 'AUTHORIZED',
      events: [{ type: 'status', at: now, detail: 'AUTHORIZED' }],
      idempotencyKey,
      createdAt: now,
    }
    try {
      return await this.store.createJob(job)
    } catch (error) {
      // Two requests can race past the lookup above with the same key; the
      // unique index is what actually decides, so the loser returns the winner's
      // job rather than surfacing a constraint violation.
      const winner = await this.store.jobByIdempotencyKey(idempotencyKey)
      if (winner) return winner
      throw error
    }
  }

  async attempt(jobId: string, action: Action, why = 'The agent asked to.') {
    const job = await this.getJob(jobId)
    const at = new Date().toISOString()

    /*
     * Does a person have to say yes first.
     *
     * Asked BEFORE the cap is charged, because `attemptSpend` increments the
     * spend counter in the same locked step it decides, and an action that is
     * waiting for an answer has not spent anything. Charging and then releasing
     * would work but would leave a watch's counter flickering every tick.
     *
     * The runner ticks on a schedule, so refusing here is a pause rather than a
     * denial: the same action comes back next tick, finds the answer, and goes
     * through. Nothing is held in memory between the two.
     */
    const auth = await this.getAuthorization(job.authorizationId)
    if (auth.status === 'active' && needsApproval(auth.policy, action.amount)) {
      const standing = await this.store.approvalFor(jobId, {
        target: action.target,
        selector: action.selector,
        asset: action.asset,
        amount: action.amount,
      })
      if (standing) {
        /*
         * Spent, so it cannot be spent again. One yes authorises one action:
         * an approval that stayed usable would turn a single answer into
         * standing permission, which is the opposite of what somebody choosing
         * "ask me every time" asked for.
         */
        await this.store.decideApproval(standing.id, ['approved'], 'used')
      } else {
        const request = await this.store.requestApproval({
          jobId,
          authorizationId: job.authorizationId,
          target: action.target,
          selector: action.selector,
          asset: action.asset,
          amount: action.amount,
          reason: why,
        })
        await this.store.appendEvents(jobId, [
          {
            type: 'policy',
            at,
            detail: `waiting for you: ${why} (${request.id})`,
          },
        ])
        return {
          allow: false,
          rule: 'approval_required',
          reason: 'This mandate says to ask you first, and nobody has answered yet.',
          approvalId: request.id,
        }
      }
    }

    const verdict = await this.store.attemptSpend(job.authorizationId, (auth) => {
      if (auth.status !== 'active')
        return {
          allow: false,
          rule: 'authorization_status',
          reason: `Authorization is ${auth.status}.`,
          spend: 0n,
        }
      const decision = evaluatePolicy(auth.policy, action, auth.spent)
      return { ...decision, spend: decision.allow ? action.amount : 0n }
    })
    if (!verdict)
      throw new ClientError('Authorization not found.', { statusCode: 404, code: 'NOT_FOUND' })

    const events: JobEvent[] = [
      {
        type: 'policy',
        at,
        detail: `${verdict.allow ? 'allow' : 'deny'}: ${verdict.rule}: ${verdict.reason}`,
      },
    ]
    let status: JobStatus
    if (verdict.allow) {
      events.push({ type: 'spend', at, detail: action.amount.toString() })
      status = 'RUNNING'
    } else {
      status = 'REJECTED'
    }
    await this.store.appendEvents(jobId, events, status)

    return { allow: verdict.allow, rule: verdict.rule, reason: verdict.reason }
  }

  /** What is waiting for an answer on this job. */
  async approvals(jobId: string) {
    return this.store.approvals(jobId)
  }

  /**
   * Answer a request.
   *
   * Only a pending one can be answered, enforced by the store's conditional
   * update, so two clicks or an approve racing a decline have exactly one
   * winner. Returns null when this caller lost or the request is already
   * spent.
   */
  async decideApproval(id: string, decision: 'approved' | 'declined') {
    return this.store.decideApproval(id, ['pending'], decision)
  }

  /**
   * Whether this mandate permits buying something, counted against its caps.
   *
   * The same locked read-decide-increment `attempt` uses, for the same reason:
   * two hires must not both fit under a cap only one of them fits under. It is
   * a separate method rather than a flag on `attempt` because a purchase is
   * evaluated against a different subset of the constraints, and because a hire
   * is not an on-chain call and should not be logged as one.
   */
  async attemptPurchase(
    authorizationId: string,
    amount: bigint,
    at: string,
    /**
     * What the purchase is paid in.
     *
     * Passed rather than assumed, because the whole point of the check is that
     * a mandate capped in one asset says nothing about spending another, and a
     * default would quietly reintroduce exactly that.
     */
    asset: string,
  ): Promise<{ allow: boolean; rule: string; reason: string }> {
    const verdict = await this.store.attemptSpend(authorizationId, (auth) => {
      if (auth.status !== 'active')
        return {
          allow: false,
          rule: 'authorization_status',
          reason: `This mandate is ${auth.status}, so it cannot pay for anything.`,
          spend: 0n,
        }
      const decision = evaluatePurchase(auth.policy, { amount, at, asset }, auth.spent)
      return { ...decision, spend: decision.allow ? amount : 0n }
    })
    if (!verdict)
      throw new ClientError('Authorization not found.', { statusCode: 404, code: 'NOT_FOUND' })
    return { allow: verdict.allow, rule: verdict.rule, reason: verdict.reason }
  }

  /** Give back an amount counted against the cap that the chain then refused. */
  async releaseSpend(authorizationId: string, amount: bigint): Promise<void> {
    await this.store.releaseSpend(authorizationId, amount)
  }

  /** Append one event to a job's log without changing its status. */
  async record(jobId: string, event: { type: JobEvent['type']; detail: string }): Promise<void> {
    await this.store.appendEvents(jobId, [{ ...event, at: new Date().toISOString() }])
  }

  /**
   * Move a job to a new state and log the move in the same write.
   *
   * `record` deliberately cannot change status, which left the money states
   * unreachable: nothing in the codebase could put a job into FUNDED or SETTLED,
   * so of the twelve states the contract defines, those two existed only as
   * type members.
   */
  /**
   * Take exclusive ownership of a job's next state. See JobStore.claim.
   *
   * Returns false when somebody else got there first, which for the two payout
   * routes is the whole point: only one of settling and refunding may take a
   * job out of FUNDED, so only one can be paid out of the shared escrow.
   */
  async claim(jobId: string, from: JobStatus[], to: JobStatus, detail: string): Promise<boolean> {
    return this.store.claim(jobId, from, to, detail)
  }

  /** Fix the terms of a sale, once. See JobStore.recordSale. */
  async recordSale(
    jobId: string,
    sale: { agentId: string; pricePoints: number; totalPoints: number; outlay: bigint },
  ): Promise<void> {
    await this.store.recordSale(jobId, sale)
  }

  async advance(jobId: string, status: JobStatus, detail: string): Promise<void> {
    await this.store.appendEvents(
      jobId,
      [{ type: 'status', detail, at: new Date().toISOString() }],
      status,
    )
  }

  async getAuthorization(id: string): Promise<AuthorizationRecord> {
    const record = await this.store.getAuthorization(id)
    if (!record)
      throw new ClientError('Authorization not found.', { statusCode: 404, code: 'NOT_FOUND' })
    return record
  }

  async getJob(id: string): Promise<JobRecord> {
    const record = await this.store.getJob(id)
    if (!record) throw new ClientError('Job not found.', { statusCode: 404, code: 'NOT_FOUND' })
    return record
  }
}
