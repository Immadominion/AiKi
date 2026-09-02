import postgres from 'postgres'
import { isTaskKind, type TaskKind } from './kinds.js'

/**
 * People who can be found and hired, rather than only people who can claim.
 *
 * The board could take an agent's money for work and wait for somebody to
 * appear. That is one half of hiring a person and not the half anybody reaches
 * for first: an agent that needs somebody who reads Mandarin contracts has no
 * way to FIND one, only to describe the work and hope somebody is watching.
 * Meanwhile the only thing on AiKi that could be looked up and hired was an
 * ERC-8004 token, which a person does not have.
 *
 * A listing here claims nothing that anybody has to believe. A name, a
 * sentence, and the kinds of work they take from the same fixed list a task is
 * posted under. What gives a listing weight is the record of work settled
 * through it, which is counted rather than asserted, on the same principle as
 * every other number in this product.
 */

export interface SellerRecord {
  address: string
  name: string
  blurb: string
  kinds: TaskKind[]
  ratePoints: number
  available: boolean
  updatedAt: string
  /**
   * What this seller has actually done here.
   *
   * Counted from settled work, never entered by them. A listing is a claim and
   * this is the evidence, which is the whole difference between AiKi and a
   * directory.
   */
  record: { delivered: number; disputed: number; earnedPoints: number }
}

const lower = (a: string) => a.toLowerCase()

interface SellerRow {
  address: string
  name: string
  blurb: string
  kinds: string[]
  rate_points: string | number
  available: boolean
  updated_at: Date | string
  delivered: string | number
  disputed: string | number
  earned: string | number
}

const toSeller = (row: SellerRow): SellerRecord => ({
  address: row.address,
  name: row.name,
  blurb: row.blurb,
  kinds: (row.kinds ?? []).filter(isTaskKind),
  ratePoints: Number(row.rate_points),
  available: row.available,
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  record: {
    delivered: Number(row.delivered),
    disputed: Number(row.disputed),
    earnedPoints: Number(row.earned),
  },
})

export class PostgresSellerStore {
  private readonly sql: postgres.Sql
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 2, idle_timeout: 20 })
  }

  /*
   * The record is computed from tasks, not stored on the seller.
   *
   * A counter somebody increments is a number that can drift from what actually
   * happened, and the one place it would drift is the place it matters. This is
   * a join, so "delivered 4, disputed 1" is always exactly what the task table
   * says and cannot be edited into something flattering.
   */
  private get withRecord() {
    return this.sql`
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE t.status = 'SETTLED') AS delivered,
               count(*) FILTER (WHERE t.status = 'DISPUTED') AS disputed,
               coalesce(sum(t.price_points) FILTER (WHERE t.status = 'SETTLED'), 0) AS earned
          FROM tasks t WHERE t.claimed_by = s.address
      ) r ON true
    `
  }

  async list(limit = 50): Promise<SellerRecord[]> {
    const rows = await this.sql<SellerRow[]>`
      SELECT s.*, r.delivered, r.disputed, r.earned FROM sellers s ${this.withRecord}
       WHERE s.available
       -- Most delivered first, because the only thing here worth ranking on is
       -- what somebody has actually finished.
       ORDER BY r.delivered DESC, s.updated_at DESC
       LIMIT ${limit}
    `
    return rows.map(toSeller)
  }

  async get(address: string): Promise<SellerRecord | null> {
    const rows = await this.sql<SellerRow[]>`
      SELECT s.*, r.delivered, r.disputed, r.earned FROM sellers s ${this.withRecord}
       WHERE s.address = ${lower(address)}
    `
    const row = rows[0]
    return row ? toSeller(row) : null
  }

  /** Create or update your own listing. Nobody can write anybody else's. */
  async put(input: {
    address: string
    name: string
    blurb: string
    kinds: TaskKind[]
    ratePoints: number
    available: boolean
  }): Promise<SellerRecord> {
    await this.sql`
      INSERT INTO sellers (address, name, blurb, kinds, rate_points, available, updated_at)
      VALUES (${lower(input.address)}, ${input.name}, ${input.blurb}, ${input.kinds},
              ${input.ratePoints}, ${input.available}, now())
      ON CONFLICT (address) DO UPDATE
        SET name = EXCLUDED.name, blurb = EXCLUDED.blurb, kinds = EXCLUDED.kinds,
            rate_points = EXCLUDED.rate_points, available = EXCLUDED.available,
            updated_at = now()
    `
    const made = await this.get(input.address)
    if (!made) throw new Error('The listing could not be saved.')
    return made
  }

  async close() {
    await this.sql.end()
  }
}
