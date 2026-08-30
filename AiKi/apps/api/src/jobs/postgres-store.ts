import type { SignedDelegation } from '@aiki/contracts'
import postgres from 'postgres'
import type { CompiledPolicy } from '../authority/policy.js'
import type {
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

interface JobRow {
  id: string
  authorization_id: string
  status: JobStatus
  idempotency_key: string
  created_at: string | Date
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
