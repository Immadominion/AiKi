import { randomUUID } from 'node:crypto'
import type { SignedDelegation } from '@aiki/contracts'
import { type Action, type Constraint, compilePolicy, evaluatePolicy } from '../authority/policy.js'
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

  async attempt(jobId: string, action: Action) {
    const job = await this.getJob(jobId)
    const at = new Date().toISOString()

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

  /** Give back an amount counted against the cap that the chain then refused. */
  async releaseSpend(authorizationId: string, amount: bigint): Promise<void> {
    await this.store.releaseSpend(authorizationId, amount)
  }

  /** Append one event to a job's log without changing its status. */
  async record(jobId: string, event: { type: JobEvent['type']; detail: string }): Promise<void> {
    await this.store.appendEvents(jobId, [{ ...event, at: new Date().toISOString() }])
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
