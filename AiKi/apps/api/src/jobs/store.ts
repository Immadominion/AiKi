import type { CompiledPolicy } from '../authority/policy.js'

export type AuthorizationStatus = 'pending' | 'active' | 'revoked' | 'expired'
export type JobStatus =
  | 'AUTHORIZED'
  | 'DISPATCHED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'

export interface AuthorizationRecord {
  id: string
  policy: CompiledPolicy
  status: AuthorizationStatus
  spent: bigint
  createdAt: string
  revokedAt?: string
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
  createAuthorization(record: AuthorizationRecord): Promise<AuthorizationRecord>
  getAuthorization(id: string): Promise<AuthorizationRecord | null>
  revokeAuthorization(id: string, at: string): Promise<AuthorizationRecord | null>

  createJob(record: JobRecord): Promise<JobRecord>
  getJob(id: string): Promise<JobRecord | null>
  jobByIdempotencyKey(key: string): Promise<JobRecord | null>
  appendEvents(jobId: string, events: JobEvent[], status?: JobStatus): Promise<void>

  attemptSpend(
    authorizationId: string,
    evaluate: (authorization: AuthorizationRecord) => SpendVerdict,
  ): Promise<SpendVerdict | null>
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
