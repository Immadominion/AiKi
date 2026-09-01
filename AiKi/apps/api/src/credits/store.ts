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

/** Asked to take a whole amount that is not there. Nothing is taken. */
export class InsufficientBalance extends Error {
  constructor(
    readonly needed: number,
    readonly held: number,
  ) {
    super(`This costs ${needed} points and the balance is ${held}.`)
    this.name = 'InsufficientBalance'
  }
}

export class DuplicateCharge extends Error {
  constructor(readonly reference: string) {
    super(`This charge has already been taken (${reference}).`)
    this.name = 'DuplicateCharge'
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
    /**
     * Makes the charge happen at most once, ever.
     *
     * Deposits have always had this and charges have not, which is why funding
     * the same job twice took the money twice: the route read a balance, decided
     * it was enough, and charged, and two callers interleaved between the read
     * and the write. A guard in the route cannot fix that; a unique index can,
     * because the second writer loses in the database rather than in a
     * comparison somebody hoped was atomic.
     */
    reference?: string
    /**
     * Take the whole amount or none of it.
     *
     * The default clamps to what is there and reports a shortfall, which is
     * right for a model turn that has already run and must be paid for
     * somehow. It is wrong for work not yet started: a partly funded job is
     * money taken for something nobody bought.
     */
    exact?: boolean
  }): Promise<{ charged: number; balance: number; shortfall: number }>
  /**
   * Move points between two accounts, both legs or neither.
   *
   * Funding a job used to debit the buyer and credit nobody, so between taking
   * the money and paying the seller it existed in no account at all: the ledger
   * did not balance, and "where is the money for this job" had no answer in the
   * record. Charging and depositing as two calls does not fix that, because the
   * second can fail and leave the first standing.
   *
   * One transaction, one reference, so a retry moves nothing a second time.
   */
  transfer(input: {
    from: string
    to: string
    points: number
    reason: string
    reference: string
    detail?: Record<string, unknown>
  }): Promise<{ moved: number; fromBalance: number; toBalance: number }>
  history(owner: string, limit?: number): Promise<CreditEntry[]>
  /**
   * How many entries of one reason have been written since a moment.
   *
   * Exists to bound the welcome grant. Signing in costs nothing but a
   * signature, so an address is free and unlimited, and a grant keyed on the
   * address is a faucet: every 5,000 points is real model spend AiKi pays for,
   * and nothing capped how many were handed out.
   */
  countSince(reason: string, since: string): Promise<number>
}

/**
 * Where a funded job's money sits until it is settled or returned.
 *
 * A house account rather than an address, because it is AiKi's obligation and
 * not anybody's property: the sum of what is in here is what the marketplace
 * owes buyers and sellers between the two halves of a sale, and it is meant to
 * be readable as exactly that.
 */
export const ESCROW_ACCOUNT = 'aiki:escrow'

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
    reference?: string
    exact?: boolean
    detail?: Record<string, unknown>
  }) {
    if (input.reference && this.entries.some((e) => e.reference === input.reference))
      throw new DuplicateCharge(input.reference)
    const balance = await this.balance(input.owner)
    if (input.exact && balance < input.points) throw new InsufficientBalance(input.points, balance)
    const charged = Math.min(balance, input.points)
    if (charged > 0)
      this.entries.push({
        id: randomUUID(),
        owner: lower(input.owner),
        delta: -charged,
        reason: input.reason,
        ...(input.reference ? { reference: input.reference } : {}),
        detail: input.detail ?? {},
        createdAt: new Date().toISOString(),
      })
    return {
      charged,
      balance: balance - charged,
      shortfall: Math.max(0, input.points - charged),
    }
  }

  async transfer(input: {
    from: string
    to: string
    points: number
    reason: string
    reference: string
    detail?: Record<string, unknown>
  }) {
    if (input.points <= 0) throw new Error('A transfer must move a positive number of points.')
    if (this.entries.some((e) => e.reference === `${input.reference}:out`))
      throw new DuplicateCharge(input.reference)
    const from = await this.balance(input.from)
    if (from < input.points) throw new InsufficientBalance(input.points, from)
    const at = new Date().toISOString()
    const leg = (owner: string, delta: number, suffix: string) =>
      this.entries.push({
        id: randomUUID(),
        owner: lower(owner),
        delta,
        reason: input.reason,
        reference: `${input.reference}:${suffix}`,
        detail: input.detail ?? {},
        createdAt: at,
      })
    leg(input.from, -input.points, 'out')
    leg(input.to, input.points, 'in')
    return {
      moved: input.points,
      fromBalance: await this.balance(input.from),
      toBalance: await this.balance(input.to),
    }
  }

  async countSince(reason: string, since: string) {
    return this.entries.filter((e) => e.reason === reason && e.createdAt >= since).length
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
    reference?: string
    exact?: boolean
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
      /*
       * Decided INSIDE the transaction, under the row lock taken above. Reading
       * the balance outside it and deciding there is how funding a job charged
       * twice: two callers both read the same number, both judged it sufficient,
       * and both wrote.
       */
      if (input.exact && balance < input.points)
        throw new InsufficientBalance(input.points, balance)
      const charged = Math.min(balance, input.points)
      if (charged > 0) {
        try {
          await tx`
            INSERT INTO credit_entries (id, owner, delta, reason, reference, detail)
            VALUES (${randomUUID()}, ${lower(input.owner)}, ${-charged}, ${input.reason},
                    ${input.reference ?? null},
                    ${tx.json((input.detail ?? {}) as postgres.JSONValue)})
          `
        } catch (error) {
          // The unique index on reference is what makes a charge happen once.
          if ((error as { code?: string }).code === '23505' && input.reference)
            throw new DuplicateCharge(input.reference)
          throw error
        }
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

  /**
   * Both legs in one transaction, so the money is never nowhere.
   *
   * The two references are one reference with a suffix, and the unique index on
   * `reference` is what makes the whole movement happen at most once: a retry
   * loses on the outbound leg before the inbound one is written.
   */
  async transfer(input: {
    from: string
    to: string
    points: number
    reason: string
    reference: string
    detail?: Record<string, unknown>
  }) {
    if (input.points <= 0) throw new Error('A transfer must move a positive number of points.')
    return this.sql.begin(async (tx) => {
      // Locked in a fixed order so two transfers between the same pair cannot
      // take each other's locks and wait forever.
      const pair = [lower(input.from), lower(input.to)].sort()
      await tx`
        SELECT owner FROM credit_balances
        WHERE owner = ANY(${pair}) ORDER BY owner FOR UPDATE
      `

      const held = await tx<{ balance: string }[]>`
        SELECT balance FROM credit_balances WHERE owner = ${lower(input.from)}
      `
      const fromBalance = Number(held[0]?.balance ?? 0)
      if (fromBalance < input.points) throw new InsufficientBalance(input.points, fromBalance)

      const write = async (owner: string, delta: number, suffix: string) => {
        await tx`
          INSERT INTO credit_entries (id, owner, delta, reason, reference, detail)
          VALUES (${randomUUID()}, ${lower(owner)}, ${delta}, ${input.reason},
                  ${`${input.reference}:${suffix}`},
                  ${tx.json((input.detail ?? {}) as postgres.JSONValue)})
        `
        const rows = await tx<{ balance: string }[]>`
          INSERT INTO credit_balances (owner, balance, updated_at)
          VALUES (${lower(owner)}, ${delta}, now())
          ON CONFLICT (owner) DO UPDATE
            SET balance = credit_balances.balance + EXCLUDED.balance, updated_at = now()
          RETURNING balance
        `
        return Number(rows[0]?.balance ?? 0)
      }

      try {
        const nextFrom = await write(input.from, -input.points, 'out')
        const nextTo = await write(input.to, input.points, 'in')
        return { moved: input.points, fromBalance: nextFrom, toBalance: nextTo }
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new DuplicateCharge(input.reference)
        throw error
      }
    })
  }

  async countSince(reason: string, since: string) {
    const rows = await this.sql<{ n: string }[]>`
      SELECT count(*) AS n FROM credit_entries
       WHERE reason = ${reason} AND created_at >= ${since}
    `
    return Number(rows[0]?.n ?? 0)
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
