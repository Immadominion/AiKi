import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

/**
 * Points, and why they moved.
 *
 * The balance is a cache of the ledger, never the other way round. Every method
 * that changes it writes an entry in the same transaction, so a balance that has
 * drifted from SUM(delta) is a bug that can be detected rather than a mystery
 * somebody has to take on faith.
 */

export interface CreditEntry {
  id: string
  owner: string
  delta: number
  reason: string
  reference?: string
  detail: Record<string, unknown>
  createdAt: string
}

export class InsufficientCredit extends Error {
  constructor(
    readonly balance: number,
    readonly needed: number,
  ) {
    super(`This needs ${needed} points and you have ${balance}.`)
  }
}

export class DuplicateDeposit extends Error {
  constructor(readonly reference: string) {
    super(`That payment has already been credited.`)
  }
}

export interface CreditStore {
  balance(owner: string): Promise<number>
  /** Adds points against a payment. Refuses to credit the same reference twice. */
  deposit(input: {
    owner: string
    points: number
    reason: string
    reference: string
    detail?: Record<string, unknown>
  }): Promise<number>
  /**
   * Takes points for work already done.
   *
   * Never below zero. A turn is estimated and reserved before it runs, so this
   * settles a known cost rather than discovering one — but a model can overrun
   * an estimate, and the honest response to that is to take what is left and
   * record the shortfall, not to invent a negative balance.
   */
  charge(input: {
    owner: string
    points: number
    reason: string
    detail?: Record<string, unknown>
  }): Promise<{ charged: number; balance: number; shortfall: number }>
  history(owner: string, limit?: number): Promise<CreditEntry[]>
}

const lower = (owner: string) => owner.toLowerCase()

export class InMemoryCreditStore implements CreditStore {
  private readonly entries: CreditEntry[] = []

  async balance(owner: string) {
    return this.entries
      .filter((e) => e.owner === lower(owner))
      .reduce((total, e) => total + e.delta, 0)
  }

  async deposit(input: {
    owner: string
    points: number
    reason: string
    reference: string
    detail?: Record<string, unknown>
  }) {
    if (this.entries.some((e) => e.reference === input.reference))
      throw new DuplicateDeposit(input.reference)
    this.entries.push({
      id: randomUUID(),
      owner: lower(input.owner),
      delta: input.points,
      reason: input.reason,
      reference: input.reference,
      detail: input.detail ?? {},
      createdAt: new Date().toISOString(),
    })
    return this.balance(input.owner)
  }

  async charge(input: {
    owner: string
    points: number
    reason: string
    detail?: Record<string, unknown>
  }) {
    const balance = await this.balance(input.owner)
    const charged = Math.min(balance, input.points)
    if (charged > 0)
      this.entries.push({
        id: randomUUID(),
        owner: lower(input.owner),
        delta: -charged,
        reason: input.reason,
        detail: input.detail ?? {},
        createdAt: new Date().toISOString(),
      })
    return {
      charged,
      balance: balance - charged,
      shortfall: Math.max(0, input.points - charged),
    }
  }

  async history(owner: string, limit = 25) {
    return this.entries
      .filter((e) => e.owner === lower(owner))
      .slice(-limit)
      .reverse()
  }
}

export class PostgresCreditStore implements CreditStore {
  private readonly sql: postgres.Sql
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 4, idle_timeout: 20 })
  }

  async balance(owner: string) {
    const rows = await this.sql<{ balance: string }[]>`
      SELECT balance FROM credit_balances WHERE owner = ${lower(owner)}
    `
    return Number(rows[0]?.balance ?? 0)
  }

  async deposit(input: {
    owner: string
    points: number
    reason: string
    reference: string
    detail?: Record<string, unknown>
  }) {
    return this.sql.begin(async (tx) => {
      try {
        await tx`
          INSERT INTO credit_entries (id, owner, delta, reason, reference, detail)
          VALUES (${randomUUID()}, ${lower(input.owner)}, ${input.points}, ${input.reason},
                  ${input.reference}, ${tx.json((input.detail ?? {}) as postgres.JSONValue)})
        `
      } catch (error) {
        // The unique index on reference is the thing stopping one payment being
        // credited twice; a retry after a timeout must not mint points.
        if ((error as { code?: string }).code === '23505')
          throw new DuplicateDeposit(input.reference)
        throw error
      }
      const rows = await tx<{ balance: string }[]>`
        INSERT INTO credit_balances (owner, balance, updated_at)
        VALUES (${lower(input.owner)}, ${input.points}, now())
        ON CONFLICT (owner) DO UPDATE
          SET balance = credit_balances.balance + EXCLUDED.balance, updated_at = now()
        RETURNING balance
      `
      return Number(rows[0]?.balance ?? 0)
    })
  }

  async charge(input: {
    owner: string
    points: number
    reason: string
    detail?: Record<string, unknown>
  }) {
    return this.sql.begin(async (tx) => {
      /*
       * The row lock is the point. Two turns settling at once would both read
       * the same balance and both subtract from it, and the cheaper of the two
       * would be free. LEAST() then keeps the balance at or above zero without
       * a second round trip to find out what was available.
       */
      const held = await tx<{ balance: string }[]>`
        SELECT balance FROM credit_balances WHERE owner = ${lower(input.owner)} FOR UPDATE
      `
      const balance = Number(held[0]?.balance ?? 0)
      const charged = Math.min(balance, input.points)
      if (charged > 0) {
        await tx`
          INSERT INTO credit_entries (id, owner, delta, reason, detail)
          VALUES (${randomUUID()}, ${lower(input.owner)}, ${-charged}, ${input.reason},
                  ${tx.json((input.detail ?? {}) as postgres.JSONValue)})
        `
        await tx`
          UPDATE credit_balances SET balance = balance - ${charged}, updated_at = now()
          WHERE owner = ${lower(input.owner)}
        `
      }
      return {
        charged,
        balance: balance - charged,
        shortfall: Math.max(0, input.points - charged),
      }
    })
  }

  async history(owner: string, limit = 25) {
    const rows = await this.sql<
      {
        id: string
        owner: string
        delta: string
        reason: string
        reference: string | null
        detail: Record<string, unknown>
        created_at: Date | string
      }[]
    >`
      SELECT * FROM credit_entries WHERE owner = ${lower(owner)}
      ORDER BY created_at DESC LIMIT ${limit}
    `
    return rows.map((r) => ({
      id: r.id,
      owner: r.owner,
      delta: Number(r.delta),
      reason: r.reason,
      ...(r.reference ? { reference: r.reference } : {}),
      detail: r.detail ?? {},
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    }))
  }

  async close() {
    await this.sql.end()
  }
}
