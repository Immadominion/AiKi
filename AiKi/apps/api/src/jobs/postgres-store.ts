import { randomUUID } from 'node:crypto'
import type { SignedDelegation } from '@aiki/contracts'
import postgres from 'postgres'
import type { CompiledPolicy } from '../authority/policy.js'
import { ClientError } from '../http/errors.js'
import type {
  ApprovalRequest,
  AuthorizationRecord,
  AuthorizationStatus,
  JobEvent,
  JobRecord,
  JobStatus,
  JobStore,
  SpendVerdict,
} from './store.js'

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value)

interface AuthorizationRow {
  id: string
  policy: CompiledPolicy
  status: AuthorizationStatus
  spent: string
  created_at: string | Date
  revoked_at: string | Date | null
  owner: string | null
  delegation: SignedDelegation | null
  delegator: string | null
  delegation_chain_id: number | string | null
  delegation_signed_at: string | Date | null
}

interface ApprovalRow {
  id: string
  job_id: string
  authorization_id: string
  target: string
  selector: string
  asset: string
  amount: string
  reason: string
  status: ApprovalRequest['status']
  requested_at: Date | string
  decided_at: Date | string | null
}

const asIso = (at: Date | string) => (at instanceof Date ? at.toISOString() : at)

const toApproval = (row: ApprovalRow): ApprovalRequest => ({
  id: row.id,
  jobId: row.job_id,
  authorizationId: row.authorization_id,
  target: row.target,
  selector: row.selector,
  asset: row.asset,
  // Read as a string and parsed. A uint256 amount loses precision through
  // Number, and this one is shown to a person who is about to agree to it.
  amount: BigInt(row.amount),
  reason: row.reason,
  status: row.status,
  requestedAt: asIso(row.requested_at),
  ...(row.decided_at ? { decidedAt: asIso(row.decided_at) } : {}),
})

interface JobRow {
  id: string
  authorization_id: string
  status: JobStatus
  idempotency_key: string
  created_at: string | Date
  sold_agent_id: string | null
  sold_price_points: string | number | null
  sold_total_points: string | number | null
  sold_outlay: string | number | null
}

interface EventRow {
  type: JobEvent['type']
  detail: string
  at: string | Date
}

const toAuthorization = (row: AuthorizationRow): AuthorizationRecord => ({
  id: row.id,
  policy: row.policy,
  status: row.status,
  // NUMERIC comes back as a string precisely so it does not lose precision in
  // a float; BigInt is the only safe destination for it.
  spent: BigInt(row.spent),
  createdAt: iso(row.created_at),
  owner: row.owner,
  ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  ...(row.delegation ? { delegation: row.delegation } : {}),
  ...(row.delegator ? { delegator: row.delegator } : {}),
  // INTEGER arrives as a number here, but every other numeric column in this
  // file has arrived as a string at least once, and a chain id read as "97"
  // would never match a comparison against 97.
  ...(row.delegation_chain_id === null
    ? {}
    : { delegationChainId: Number(row.delegation_chain_id) }),
  ...(row.delegation_signed_at ? { delegationSignedAt: iso(row.delegation_signed_at) } : {}),
})

/** Authorizations, jobs, and their event logs, in Postgres. */
export class PostgresJobStore implements JobStore {
  private readonly sql: postgres.Sql

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5 })
  }

  async createAuthorization(record: AuthorizationRecord) {
    await this.sql`
      INSERT INTO authorizations (id, policy_hash, policy, weakest_tier, status, spent, expires_at, created_at, owner)
      VALUES (
        ${record.id},
        ${record.policy.hash},
        ${this.sql.json(record.policy as unknown as postgres.JSONValue)},
        ${record.policy.weakestTier},
        ${record.status},
        ${record.spent.toString()},
        ${record.policy.expiresAt ?? null},
        ${record.createdAt},
        ${record.owner}
      )
    `
    return record
  }

  async getAuthorization(id: string) {
    const rows = await this.sql<AuthorizationRow[]>`SELECT * FROM authorizations WHERE id = ${id}`
    const row = rows[0]
    return row ? toAuthorization(row) : null
  }

  async revokeAuthorization(id: string, at: string) {
    const rows = await this.sql<AuthorizationRow[]>`
      UPDATE authorizations SET status = 'revoked', revoked_at = ${at}
      WHERE id = ${id} RETURNING *
    `
    const row = rows[0]
    return row ? toAuthorization(row) : null
  }

  async attachDelegation(
    id: string,
    delegation: SignedDelegation,
    delegator: string,
    chainId: number,
    at: string,
  ) {
    // `delegation IS NULL` in the WHERE, not a read-then-write: two requests
    // racing to sign the same mandate would otherwise both read no delegation
    // and the second would overwrite the first. The first signature stands.
    const rows = await this.sql<AuthorizationRow[]>`
      UPDATE authorizations
      SET delegation = ${this.sql.json(delegation as unknown as postgres.JSONValue)},
          delegator = ${delegator},
          delegation_chain_id = ${chainId},
          delegation_signed_at = ${at}
      WHERE id = ${id} AND delegation IS NULL
      RETURNING *
    `
    const row = rows[0]
    // Nothing updated means either no such mandate or one already signed. The
    // caller is handed whatever is actually stored rather than an error, so a
    // retried request is idempotent instead of alarming.
    if (row) return toAuthorization(row)
    return this.getAuthorization(id)
  }

  async createJob(record: JobRecord) {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO jobs (id, authorization_id, status, idempotency_key, created_at, updated_at)
        VALUES (${record.id}, ${record.authorizationId}, ${record.status}, ${record.idempotencyKey}, ${record.createdAt}, ${record.createdAt})
      `
      for (const event of record.events)
        await tx`
          INSERT INTO job_events (job_id, type, detail, at)
          VALUES (${record.id}, ${event.type}, ${event.detail}, ${event.at})
        `
    })
    return record
  }

  async getJob(id: string) {
    const rows = await this.sql<JobRow[]>`SELECT * FROM jobs WHERE id = ${id}`
    const row = rows[0]
    if (!row) return null
    return this.hydrate(row)
  }

  async jobByIdempotencyKey(key: string) {
    const rows = await this.sql<JobRow[]>`SELECT * FROM jobs WHERE idempotency_key = ${key}`
    const row = rows[0]
    return row ? this.hydrate(row) : null
  }

  async appendEvents(jobId: string, events: JobEvent[], status?: JobStatus) {
    if (!events.length && !status) return
    await this.sql.begin(async (tx) => {
      for (const event of events)
        await tx`
          INSERT INTO job_events (job_id, type, detail, at)
          VALUES (${jobId}, ${event.type}, ${event.detail}, ${event.at})
        `
      if (status)
        await tx`UPDATE jobs SET status = ${status}, updated_at = now() WHERE id = ${jobId}`
    })
  }

  /**
   * Evaluating a cap and committing the spend happen under a row lock, so two
   * concurrent actions cannot both read the same total and both squeeze past a
   * cap only one of them fits under.
   */
  async releaseSpend(authorizationId: string, amount: bigint) {
    // GREATEST rather than a read-then-write: the subtraction happens inside the
    // one statement, so it cannot race another action's charge, and the floor is
    // applied by the database rather than by whoever called this.
    await this.sql`
      UPDATE authorizations
      SET spent = GREATEST(spent - ${amount.toString()}, 0)
      WHERE id = ${authorizationId}
    `
  }

  async requestApproval(
    request: Omit<ApprovalRequest, 'id' | 'status' | 'requestedAt' | 'decidedAt'>,
  ): Promise<ApprovalRequest> {
    /*
     * The partial unique index decides, not a read followed by a write. The
     * runner raises the same action every tick until somebody answers, and two
     * ticks overlapping would otherwise both find nothing pending and both
     * insert. ON CONFLICT DO NOTHING then returns no row, so the existing one
     * is read back and returned: asking again gets the same question.
     */
    const inserted = await this.sql<ApprovalRow[]>`
      INSERT INTO job_approvals
        (id, job_id, authorization_id, target, selector, asset, amount, reason, status)
      VALUES (${randomUUID()}, ${request.jobId}, ${request.authorizationId},
              ${request.target}, ${request.selector}, ${request.asset},
              ${request.amount.toString()}, ${request.reason}, 'pending')
      ON CONFLICT DO NOTHING
      RETURNING *
    `
    const made = inserted[0]
    if (made) return toApproval(made)
    const waiting = await this.sql<ApprovalRow[]>`
      SELECT * FROM job_approvals
       WHERE job_id = ${request.jobId} AND status = 'pending'
         AND lower(target) = lower(${request.target})
         AND lower(selector) = lower(${request.selector})
         AND lower(asset) = lower(${request.asset})
         AND amount = ${request.amount.toString()}
       LIMIT 1
    `
    const row = waiting[0]
    if (!row) throw new Error('The approval request could not be recorded or found.')
    return toApproval(row)
  }

  async approvalFor(
    jobId: string,
    action: { target: string; selector: string; asset: string; amount: bigint },
  ): Promise<ApprovalRequest | null> {
    const rows = await this.sql<ApprovalRow[]>`
      SELECT * FROM job_approvals
       WHERE job_id = ${jobId} AND status = 'approved'
         AND lower(target) = lower(${action.target})
         AND lower(selector) = lower(${action.selector})
         AND lower(asset) = lower(${action.asset})
         AND amount = ${action.amount.toString()}
       ORDER BY requested_at DESC LIMIT 1
    `
    const row = rows[0]
    return row ? toApproval(row) : null
  }

  async approvals(jobId: string): Promise<ApprovalRequest[]> {
    const rows = await this.sql<ApprovalRow[]>`
      SELECT * FROM job_approvals WHERE job_id = ${jobId} ORDER BY requested_at DESC
    `
    return rows.map(toApproval)
  }

  async decideApproval(
    id: string,
    from: ApprovalRequest['status'][],
    to: ApprovalRequest['status'],
  ): Promise<ApprovalRequest | null> {
    // One conditional UPDATE, so two clicks cannot both land and a decline
    // racing an approve has exactly one winner.
    const rows = await this.sql<ApprovalRow[]>`
      UPDATE job_approvals SET status = ${to}, decided_at = now()
       WHERE id = ${id} AND status = ANY(${from})
      RETURNING *
    `
    const row = rows[0]
    return row ? toApproval(row) : null
  }

  async attemptSpend(
    authorizationId: string,
    evaluate: (authorization: AuthorizationRecord) => SpendVerdict,
  ) {
    return this.sql.begin(async (tx) => {
      const rows = await tx<AuthorizationRow[]>`
        SELECT * FROM authorizations WHERE id = ${authorizationId} FOR UPDATE
      `
      const row = rows[0]
      if (!row) return null
      const verdict = evaluate(toAuthorization(row))
      if (verdict.allow)
        await tx`
          UPDATE authorizations SET spent = spent + ${verdict.spend.toString()}
          WHERE id = ${authorizationId}
        `
      return verdict
    }) as Promise<SpendVerdict | null>
  }

  /**
   * One conditional UPDATE, so exactly one caller wins.
   *
   * `WHERE status = ANY(from)` is the whole guard: two callers racing to pay out
   * of the same escrow both match the read but only one matches the write.
   */
  async claim(jobId: string, from: JobStatus[], to: JobStatus, detail: string) {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        UPDATE jobs SET status = ${to}, updated_at = now()
         WHERE id = ${jobId} AND status = ANY(${from})
        RETURNING id
      `
      if (rows.length === 0) return false
      await tx`
        INSERT INTO job_events (job_id, type, detail, at)
        VALUES (${jobId}, 'status', ${detail}, now())
      `
      return true
    })
  }

  /**
   * Fix the terms, once.
   *
   * The WHERE clause is the guard: it only matches a job that has not been sold
   * yet, so two funders racing cannot both write terms, and the caller is told
   * which one lost rather than the second quietly overwriting the first.
   */
  async recordSale(
    jobId: string,
    sale: { agentId: string; pricePoints: number; totalPoints: number; outlay: bigint },
  ) {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE jobs
         SET sold_agent_id = ${sale.agentId},
             sold_price_points = ${sale.pricePoints},
             sold_total_points = ${sale.totalPoints},
             sold_outlay = ${sale.outlay.toString()},
             updated_at = now()
       WHERE id = ${jobId} AND sold_agent_id IS NULL
      RETURNING id
    `
    if (rows.length === 0)
      throw new ClientError('This job has already been sold.', {
        statusCode: 409,
        code: 'JOB_ALREADY_FUNDED',
      })
  }

  private async hydrate(row: JobRow): Promise<JobRecord> {
    const events = await this.sql<EventRow[]>`
      SELECT type, detail, at FROM job_events WHERE job_id = ${row.id} ORDER BY seq
    `
    return {
      id: row.id,
      authorizationId: row.authorization_id,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      createdAt: iso(row.created_at),
      ...(row.sold_agent_id && row.sold_price_points !== null && row.sold_total_points !== null
        ? {
            sale: {
              agentId: row.sold_agent_id,
              // BIGINT arrives as a string; every comparison downstream is
              // numeric, and a string here compares as text.
              pricePoints: Number(row.sold_price_points),
              totalPoints: Number(row.sold_total_points),
              /*
               * Read as a string and parsed, never through Number. A uint256
               * amount loses precision the moment it becomes a float, and the
               * number this one feeds is a spend cap.
               */
              outlay: BigInt(row.sold_outlay ?? 0),
            },
          }
        : {}),
      events: events.map((event) => ({
        type: event.type,
        detail: event.detail,
        at: iso(event.at),
      })),
    }
  }

  async close() {
    await this.sql.end()
  }
}
