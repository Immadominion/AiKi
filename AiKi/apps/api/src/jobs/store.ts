import type { SignedDelegation } from '@aiki/contracts'
import type { CompiledPolicy } from '../authority/policy.js'
import { ClientError } from '../http/errors.js'

export type AuthorizationStatus = 'pending' | 'active' | 'revoked' | 'expired'
export type JobStatus =
  | 'AUTHORIZED'
  /** The buyer has paid and the money is held. Nothing reaches the agent yet. */
  | 'FUNDED'
  | 'DISPATCHED'
  | 'RUNNING'
  | 'COMPLETED'
  /** The work was accepted and the agent's owner has been paid. */
  | 'SETTLED'
  | 'REJECTED'
  | 'CANCELLED'

export interface AuthorizationRecord {
  id: string
  policy: CompiledPolicy
  status: AuthorizationStatus
  spent: bigint
  createdAt: string
  revokedAt?: string
  /** The address that signed for this mandate. Null only for rows written before authentication existed. */
  owner: string | null
  /**
   * The delegation the owner signed, if they have. Absent means the limits are
   * counted by AiKi and nothing on a chain knows about this mandate.
   */
  delegation?: SignedDelegation
  /** The account the value comes out of, and the chain its manager is on. */
  delegator?: string
  delegationChainId?: number
  delegationSignedAt?: string
}

export interface JobEvent {
  type: 'status' | 'policy' | 'spend'
  at: string
  detail: string
}

export interface JobRecord {
  id: string
  authorizationId: string
  status: JobStatus
  events: JobEvent[]
  idempotencyKey: string
  createdAt: string
  /**
   * The terms of the sale, fixed when the buyer paid.
   *
   * Absent until funding. Settlement reads the agent and the amount from HERE
   * rather than from the request body and a fresh look at the registry, because
   * a caller naming the agent meant a buyer could have the money paid to an
   * address they controlled, and re-pricing meant the seller could be paid a
   * different number from the one the buyer was charged.
   */
  sale?: { agentId: string; pricePoints: number; totalPoints: number }
}

/** What an evaluator returns: a verdict, plus what it costs when allowed. */
export interface SpendVerdict {
  allow: boolean
  rule: string
  reason: string
  spend: bigint
}

/**
 * Where authorizations, jobs, and receipts actually live.
 *
 * The one operation that is not plain CRUD is attemptSpend: evaluating a cap and
 * recording the spend must be atomic, or two concurrent actions both read the
 * old total and both pass a cap that only one of them fits under. The store owns
 * that atomicity because only the store knows how to hold a lock; the caller
 * still owns the policy, which it passes in as the evaluator.
 */
export interface JobStore {
  /**
   * Move a job from one of `from` to `to`, and say whether this caller did it.
   *
   * The payout guard. Settling and refunding both take money out of one pooled
   * escrow account and used different idempotency keys, so the unique index
   * could not see them racing: run concurrently they both read FUNDED, both
   * decided they were allowed, and both paid out against a single funding, with
   * the second payment coming from other buyers' money in the same account.
   *
   * Reading a status and then acting on it cannot fix that. This is one
   * conditional UPDATE, so exactly one caller matches and the other is told it
   * lost.
   */
  claim(jobId: string, from: JobStatus[], to: JobStatus, detail: string): Promise<boolean>

  /**
   * Fix the terms of a sale. Refuses if this job has already been sold.
   *
   * Required, not optional. A store that quietly does not record the sale can
   * still take a buyer's money, and settlement then finds no terms and refuses
   * forever: the money would sit in escrow with nothing able to release it.
   */
  recordSale(
    jobId: string,
    sale: { agentId: string; pricePoints: number; totalPoints: number },
  ): Promise<void>
  createAuthorization(record: AuthorizationRecord): Promise<AuthorizationRecord>
  getAuthorization(id: string): Promise<AuthorizationRecord | null>
  revokeAuthorization(id: string, at: string): Promise<AuthorizationRecord | null>
  /**
   * Attach a signature to a mandate that already exists.
   *
   * Separate from creating one because they happen at different moments: the
   * limits are chosen and stored first, and only then is a wallet asked to sign
   * them. Refuses a mandate that is already signed rather than replacing it,
   * since a second signature over different terms is how the limits somebody
   * agreed to would quietly become different limits.
   */
  attachDelegation(
    id: string,
    delegation: SignedDelegation,
    delegator: string,
    chainId: number,
    at: string,
  ): Promise<AuthorizationRecord | null>

  createJob(record: JobRecord): Promise<JobRecord>
  getJob(id: string): Promise<JobRecord | null>
  jobByIdempotencyKey(key: string): Promise<JobRecord | null>
  appendEvents(jobId: string, events: JobEvent[], status?: JobStatus): Promise<void>

  attemptSpend(
    authorizationId: string,
    evaluate: (authorization: AuthorizationRecord) => SpendVerdict,
  ): Promise<SpendVerdict | null>

  /**
   * Give back an amount that was counted against the cap but never moved.
   *
   * The off-chain cap is checked and charged in one locked step, which is what
   * stops two concurrent actions both fitting under a limit only one of them
   * fits under. That charge happens before the chain has spoken, so when the
   * chain then refuses the action, the counter is ahead of reality and every
   * later action is measured against a spend that never occurred.
   *
   * Never below zero: a counter that could go negative would hand back more room
   * than the mandate ever had.
   */
  releaseSpend(authorizationId: string, amount: bigint): Promise<void>
}

/** The default store: fine for tests and the sweep-backed dev server, and nowhere else. */
export class InMemoryJobStore implements JobStore {
  private readonly authorizations = new Map<string, AuthorizationRecord>()
  private readonly jobs = new Map<string, JobRecord>()
  private readonly byKey = new Map<string, string>()

  async createAuthorization(record: AuthorizationRecord) {
    this.authorizations.set(record.id, { ...record })
    return record
  }

  async getAuthorization(id: string) {
    const held = this.authorizations.get(id)
    return held ? { ...held } : null
  }

  async revokeAuthorization(id: string, at: string) {
    const held = this.authorizations.get(id)
    if (!held) return null
    held.status = 'revoked'
    held.revokedAt = at
    return { ...held }
  }

  async attachDelegation(
    id: string,
    delegation: SignedDelegation,
    delegator: string,
    chainId: number,
    at: string,
  ) {
    const held = this.authorizations.get(id)
    if (!held) return null
    // Signing again over different terms is how the limits somebody agreed to
    // would quietly become different limits, so the first signature stands.
    if (held.delegation) return { ...held }
    held.delegation = delegation
    held.delegator = delegator
    held.delegationChainId = chainId
    held.delegationSignedAt = at
    return { ...held }
  }

  async releaseSpend(authorizationId: string, amount: bigint) {
    const held = this.authorizations.get(authorizationId)
    if (!held) return
    held.spent = held.spent > amount ? held.spent - amount : 0n
  }

  async createJob(record: JobRecord) {
    this.jobs.set(record.id, { ...record, events: [...record.events] })
    this.byKey.set(record.idempotencyKey, record.id)
    return record
  }

  async getJob(id: string) {
    const held = this.jobs.get(id)
    return held ? { ...held, events: [...held.events] } : null
  }

  async jobByIdempotencyKey(key: string) {
    const id = this.byKey.get(key)
    return id ? this.getJob(id) : null
  }

  async claim(jobId: string, from: JobStatus[], to: JobStatus, detail: string) {
    const job = this.jobs.get(jobId)
    if (!job || !from.includes(job.status)) return false
    this.jobs.set(jobId, {
      ...job,
      status: to,
      events: [...job.events, { type: 'status', detail, at: new Date().toISOString() }],
    })
    return true
  }

  async recordSale(
    jobId: string,
    sale: { agentId: string; pricePoints: number; totalPoints: number },
  ) {
    const job = this.jobs.get(jobId)
    if (!job) throw new ClientError('Job not found.', { statusCode: 404, code: 'NOT_FOUND' })
    // Once, so two funders racing cannot both write terms.
    if (job.sale)
      throw new ClientError('This job has already been sold.', {
        statusCode: 409,
        code: 'JOB_ALREADY_FUNDED',
      })
    this.jobs.set(jobId, { ...job, sale })
  }

  async appendEvents(jobId: string, events: JobEvent[], status?: JobStatus) {
    const held = this.jobs.get(jobId)
    if (!held) return
    held.events.push(...events)
    if (status) held.status = status
  }

  // Single-threaded JavaScript gives this the atomicity the SQL store gets from
  // a row lock: nothing else runs between the read and the write.
  async attemptSpend(
    authorizationId: string,
    evaluate: (authorization: AuthorizationRecord) => SpendVerdict,
  ) {
    const held = this.authorizations.get(authorizationId)
    if (!held) return null
    const verdict = evaluate({ ...held })
    if (verdict.allow) held.spent += verdict.spend
    return verdict
  }
}
