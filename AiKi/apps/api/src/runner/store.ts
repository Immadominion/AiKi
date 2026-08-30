import postgres from 'postgres'

/**
 * The rows that make an agent wake up.
 *
 * A mandate is permission and a job is a unit of work; neither causes anything
 * to happen on its own. A watch is the standing instruction — keep looking at
 * this position, on this cadence — and it is what separates an agent you hired
 * from a button you have to press.
 */

export type WatchStatus = 'active' | 'stopped'

export interface Watch {
  jobId: string
  authorizationId: string
  /** The position under protection. */
  account: string
  chainId: number
  protocol: 'venus'
  /** The line being defended, as a decimal string. */
  minimumHealthFactor: string
  /** What is repaid, and the market it is repaid into. */
  asset: string
  repayTo: string
  status: WatchStatus
  createdAt: string
  /**
   * Kept apart deliberately. "Looked, all well" and "did something" are
   * different facts, and a user who cannot tell them apart cannot tell a quiet
   * watch from a dead one.
   */
  lastCheckedAt?: string
  lastActedAt?: string
  lastReason?: string
}

export interface WatchStore {
  /** Refuses a second watch on a job rather than replacing the first. */
  create(watch: Watch): Promise<Watch>
  get(jobId: string): Promise<Watch | null>
  /**
   * Take ownership of the watches that are due, oldest look first.
   *
   * This writes: it stamps `last_checked_at` as it hands each row out, which is
   * what stops two schedulers picking up the same watch and repaying the same
   * shortfall twice. The cap would catch the second repayment, but only after it
   * had spent gas being told so.
   *
   * The cost of claiming up front is that a pass which crashes leaves the watch
   * looking checked until the next interval. That is the right way round: a
   * position checked late is a worse outcome than a position repaid twice only
   * if you have never been repaid twice.
   *
   * `staleMs` is the cadence, applied here rather than in the sweep so a pass
   * that runs late does not skip everything it was late for.
   */
  claimDue(now: Date, staleMs: number, limit: number): Promise<Watch[]>
  /** What the pass saw, whether or not it did anything about it. */
  noteChecked(jobId: string, at: string, reason: string, actedAt?: string): Promise<void>
  stop(jobId: string): Promise<void>
  listForAuthorizations(ids: string[]): Promise<Watch[]>
}

const lower = (value: string) => value.toLowerCase()

const normalise = (watch: Watch): Watch => ({
  ...watch,
  account: lower(watch.account),
  asset: lower(watch.asset),
  repayTo: lower(watch.repayTo),
})

export class InMemoryWatchStore implements WatchStore {
  private readonly rows = new Map<string, Watch>()

  async create(watch: Watch) {
    if (this.rows.has(watch.jobId)) throw new Error('That job is already being watched.')
    const stored = normalise(watch)
    this.rows.set(watch.jobId, stored)
    return stored
  }

  async get(jobId: string) {
    return this.rows.get(jobId) ?? null
  }

  async claimDue(now: Date, staleMs: number, limit: number) {
    const cutoff = now.getTime() - staleMs
    const claimed = [...this.rows.values()]
      .filter((row) => row.status === 'active')
      .filter((row) => !row.lastCheckedAt || Date.parse(row.lastCheckedAt) <= cutoff)
      .sort((a, b) => Date.parse(a.lastCheckedAt ?? '0') - Date.parse(b.lastCheckedAt ?? '0'))
      .slice(0, limit)
    return claimed.map((row) => {
      const stamped = { ...row, lastCheckedAt: now.toISOString() }
      this.rows.set(row.jobId, stamped)
      return stamped
    })
  }

  async noteChecked(jobId: string, at: string, reason: string, actedAt?: string) {
    const row = this.rows.get(jobId)
    if (!row) return
    this.rows.set(jobId, {
      ...row,
      lastCheckedAt: at,
      lastReason: reason,
      // Only overwritten when it acted, so the last action's time survives every
      // quiet pass after it.
      ...(actedAt ? { lastActedAt: actedAt } : {}),
    })
  }

  async stop(jobId: string) {
    const row = this.rows.get(jobId)
    if (row) this.rows.set(jobId, { ...row, status: 'stopped' })
  }

  async listForAuthorizations(ids: string[]) {
    const wanted = new Set(ids)
    return [...this.rows.values()].filter((row) => wanted.has(row.authorizationId))
  }
}

export class PostgresWatchStore implements WatchStore {
  private readonly sql: postgres.Sql
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 4, idle_timeout: 20 })
  }

  async create(watch: Watch) {
    const row = normalise(watch)
    const inserted = await this.sql<WatchRow[]>`
      INSERT INTO watches (
        job_id, authorization_id, account, chain_id, protocol,
        minimum_health_factor, asset, repay_to, status, created_at
      ) VALUES (
        ${row.jobId}, ${row.authorizationId}, ${row.account}, ${row.chainId}, ${row.protocol},
        ${row.minimumHealthFactor}, ${row.asset}, ${row.repayTo}, ${row.status}, ${row.createdAt}
      )
      ON CONFLICT (job_id) DO NOTHING
      RETURNING *
    `
    const created = inserted[0]
    if (!created) throw new Error('That job is already being watched.')
    return toWatch(created)
  }

  async get(jobId: string) {
    const rows = await this.sql<WatchRow[]>`SELECT * FROM watches WHERE job_id = ${jobId}`
    const row = rows[0]
    return row ? toWatch(row) : null
  }

  async claimDue(now: Date, staleMs: number, limit: number) {
    const cutoff = new Date(now.getTime() - staleMs).toISOString()
    /*
     * Selecting and claiming in one statement, because they have to be atomic.
     * A plain SELECT ... FOR UPDATE would not do it here: this driver runs each
     * query in its own implicit transaction, so the lock is released the moment
     * the SELECT returns and a second scheduler reads the same rows anyway.
     *
     * A CTE rather than `WHERE job_id IN (SELECT ... FOR UPDATE SKIP LOCKED)`:
     * this is the form whose locking behaviour is actually specified, and the
     * cost of being wrong here is a position repaid twice. Both orderings are
     * covered — a second scheduler running at the same moment skips the locked
     * row and claims nothing, and one arriving after the first commits sees the
     * check time just written and is excluded by the staleness test.
     *
     * The rows come back with the check time already set to now, which is what
     * they mean: this pass is looking at them. Nothing downstream needs the
     * previous value — the cooldown that stops a double repayment reads
     * last_acted_at, which this does not touch.
     */
    const rows = await this.sql<WatchRow[]>`
      WITH due AS (
        SELECT job_id FROM watches
        WHERE status = 'active'
          AND (last_checked_at IS NULL OR last_checked_at <= ${cutoff})
        ORDER BY last_checked_at ASC NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE watches SET last_checked_at = ${now.toISOString()}
      FROM due
      WHERE watches.job_id = due.job_id
      RETURNING watches.*
    `
    return rows.map(toWatch)
  }

  async noteChecked(jobId: string, at: string, reason: string, actedAt?: string) {
    await this.sql`
      UPDATE watches SET
        last_checked_at = ${at},
        last_reason = ${reason},
        last_acted_at = COALESCE(${actedAt ?? null}, last_acted_at)
      WHERE job_id = ${jobId}
    `
  }

  async stop(jobId: string) {
    await this.sql`UPDATE watches SET status = 'stopped' WHERE job_id = ${jobId}`
  }

  async listForAuthorizations(ids: string[]) {
    if (ids.length === 0) return []
    const rows = await this.sql<WatchRow[]>`
      SELECT * FROM watches WHERE authorization_id = ANY(${ids}) ORDER BY created_at DESC
    `
    return rows.map(toWatch)
  }

  async close() {
    await this.sql.end()
  }
}

interface WatchRow {
  job_id: string
  authorization_id: string
  account: string
  chain_id: number | string
  protocol: string
  minimum_health_factor: string
  asset: string
  repay_to: string
  status: string
  created_at: string | Date
  last_checked_at: string | Date | null
  last_acted_at: string | Date | null
  last_reason: string | null
}

const iso = (value: string | Date | null): string | undefined =>
  value === null ? undefined : value instanceof Date ? value.toISOString() : value

const toWatch = (row: WatchRow): Watch => {
  // Bound once each, because the conditional spreads below call these twice and
  // the compiler cannot see that the guard narrows the second call.
  const lastCheckedAt = iso(row.last_checked_at)
  const lastActedAt = iso(row.last_acted_at)
  return {
    jobId: row.job_id,
    authorizationId: row.authorization_id,
    account: row.account,
    // INTEGER has arrived as a string from this driver before, and a chain id read
    // as "97" never equals 97.
    chainId: Number(row.chain_id),
    protocol: row.protocol as 'venus',
    minimumHealthFactor: row.minimum_health_factor,
    asset: row.asset,
    repayTo: row.repay_to,
    status: row.status as WatchStatus,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(lastActedAt ? { lastActedAt } : {}),
    ...(row.last_reason ? { lastReason: row.last_reason } : {}),
  }
}
