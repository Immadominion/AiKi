import { randomUUID } from 'node:crypto'
import {
  type Action,
  type CompiledPolicy,
  type Constraint,
  compilePolicy,
  evaluatePolicy,
} from '../authority/policy.js'
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
export class JobService {
  private readonly authorizations = new Map<string, AuthorizationRecord>()
  private readonly jobs = new Map<string, JobRecord>()
  private readonly idempotency = new Map<string, string>()
  authorize(constraints: Constraint[]) {
    const now = new Date().toISOString()
    const record: AuthorizationRecord = {
      id: randomUUID(),
      policy: compilePolicy(constraints),
      status: 'active',
      spent: 0n,
      createdAt: now,
    }
    this.authorizations.set(record.id, record)
    return record
  }
  revoke(id: string) {
    const record = this.requireAuth(id)
    record.status = 'revoked'
    record.revokedAt = new Date().toISOString()
    return record
  }
  createJob(authorizationId: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new Error('Idempotency-Key is required.')
    const old = this.idempotency.get(idempotencyKey)
    if (old) return this.jobs.get(old) as JobRecord
    const auth = this.requireAuth(authorizationId)
    if (auth.status !== 'active') throw new Error(`Authorization is ${auth.status}.`)
    const job: JobRecord = {
      id: randomUUID(),
      authorizationId,
      status: 'AUTHORIZED',
      events: [{ type: 'status', at: new Date().toISOString(), detail: 'AUTHORIZED' }],
      idempotencyKey,
      createdAt: new Date().toISOString(),
    }
    this.jobs.set(job.id, job)
    this.idempotency.set(idempotencyKey, job.id)
    return job
  }
  attempt(jobId: string, action: Action) {
    const job = this.requireJob(jobId)
    const auth = this.requireAuth(job.authorizationId)
    if (auth.status !== 'active') {
      this.event(job, 'policy', `deny: authorization ${auth.status}`)
      return {
        allow: false,
        rule: 'authorization_status',
        reason: `Authorization is ${auth.status}.`,
      }
    }
    const verdict = evaluatePolicy(auth.policy, action, auth.spent)
    this.event(
      job,
      'policy',
      `${verdict.allow ? 'allow' : 'deny'}: ${verdict.rule}: ${verdict.reason}`,
    )
    if (!verdict.allow) {
      job.status = 'REJECTED'
      return verdict
    }
    auth.spent += action.amount
    job.status = 'RUNNING'
    this.event(job, 'spend', action.amount.toString())
    return verdict
  }
  getAuthorization(id: string) {
    return this.requireAuth(id)
  }
  getJob(id: string) {
    return this.requireJob(id)
  }
  private event(job: JobRecord, type: JobEvent['type'], detail: string) {
    job.events.push({ type, detail, at: new Date().toISOString() })
  }
  private requireAuth(id: string) {
    const value = this.authorizations.get(id)
    if (!value) throw new Error('Authorization not found.')
    return value
  }
  private requireJob(id: string) {
    const value = this.jobs.get(id)
    if (!value) throw new Error('Job not found.')
    return value
  }
}
