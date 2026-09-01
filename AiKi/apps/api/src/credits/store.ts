import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

/**
 * Points, and why they moved.
 *
 * The balance is a cache of the ledger, never the other way round. Every method
 * that changes it writes an entry in the same transaction, so a balance that has
 * drifted from SUM(delta) is a bug that can be detected rather than a mystery
 * somebody has to take on faith.
 *
 * Every movement writes BOTH sides. This was not always true, and the cost was
 * measurable: on production, six reasons had moved points and not one of them
 * summed to zero, because a deposit credited somebody from nowhere and a charge
 * deleted points into nowhere. A ledger with one side per movement cannot answer
 * "where did this go", so a job that took a buyer's money and paid nobody looked
 * exactly like a job that had paid correctly.
 *
 * The invariant this file exists to hold, checkable in one query and checked by
 * `reconcile.ts`:
 *
 *     SELECT reason, sum(delta) FROM credit_entries GROUP BY reason
 *
 * every row zero, and the whole table zero. Points are neither created nor
 * destroyed by any operation here; they only ever change account.
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
   * How many times one reason has moved points to a person since a moment.
   *
   * Exists to bound the welcome grant. Signing in costs nothing but a
   * signature, so an address is free and unlimited, and a grant keyed on the
   * address is a faucet: every 5,000 points is real model spend AiKi pays for,
   * and nothing capped how many were handed out.
   *
   * House accounts are not counted. Every movement now writes two entries, and
   * counting both would have quietly halved this cap the day double-entry
   * landed: two hundred grants a day would have become a hundred, with nothing
   * to say why.
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

/**
 * Where issued points come from.
 *
 * The one account allowed to hold a negative balance, and that balance is the
 * point of it: it is what AiKi has put into people's hands and not yet been
 * paid back in work, which is a liability and reads as one. Every other
 * account, escrow included, is refused below zero by the database, so escrow
 * can never pay out money nobody put in.
 */
export const ISSUANCE_ACCOUNT = 'aiki:issuance'

/**
 * Where consumed points end up.
 *
 * A Fast mode turn is not a transfer to another person: it costs AiKi real
 * money at a model provider, and the points pay for that. Consumed is still a
 * destination though, and naming it is the difference between "1,376 points
 * were spent on model calls" and 1,376 points that simply are not in the table
 * any more.
 */
export const REVENUE_ACCOUNT = 'aiki:revenue'

/**
 * What is held for a turn that is currently running.
 *
 * Fast mode cannot price a turn until it is over, and it used to gate on a
 * balance and settle afterwards with whatever was left: on production the gate
 * was 200 points and real turns cost 402, 263 and 711, each shortfall quietly
 * forgiven. Two turns in two tabs made it worse, because both read the same
 * balance and both judged it enough.
 *
 * So the turn is paid for before it runs, out of an account that holds the
 * money while the model works, and the ceiling is enforced by the loop rather
 * than discovered afterwards. What is not used comes straight back.
 */
export const RESERVE_ACCOUNT = 'aiki:reserved'

const lower = (owner: string) => owner.toLowerCase()

export class InMemoryCreditStore implements CreditStore {
  private readonly entries: CreditEntry[] = []

  async balance(owner: string) {
    return this.entries
      .filter((e) => e.owner === lower(owner))
      .reduce((total, e) => total + e.delta, 0)
  }

  /** One side of a movement. Never called alone; see the note on both callers. */
  private write(
    owner: string,
    delta: number,
    reason: string,
    reference: string | undefined,
    detail: Record<string, unknown>,
  ) {
    this.entries.push({
      id: randomUUID(),
      owner: lower(owner),
      delta,
      reason,
      ...(reference ? { reference } : {}),
      detail,
      createdAt: new Date().toISOString(),
    })
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
    // Issued, not conjured. The points come out of the account that stands for
    // everything AiKi has put into circulation.
    this.write(input.owner, input.points, input.reason, input.reference, input.detail ?? {})
    this.write(ISSUANCE_ACCOUNT, -input.points, input.reason, `${input.reference}:src`, {
      issuedTo: lower(input.owner),
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
    if (charged > 0) {
      this.write(input.owner, -charged, input.reason, input.reference, input.detail ?? {})
      // Spent, not deleted. What a turn costs AiKi is a number somebody should
      // be able to read off the ledger rather than infer from an absence.
      this.write(
        REVENUE_ACCOUNT,
        charged,
        input.reason,
        input.reference ? `${input.reference}:dst` : undefined,
        { spentBy: lower(input.owner) },
      )
    }
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
    // Issuance is the one account whose balance is allowed to be negative.
    if (lower(input.from) !== ISSUANCE_ACCOUNT && from < input.points)
      throw new InsufficientBalance(input.points, from)
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
    return this.entries.filter(
      (e) => e.reason === reason && e.createdAt >= since && !e.owner.startsWith('aiki:'),
    ).length
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

  /**
   * Take every row lock this movement needs, in one fixed order.
   *
   * Ascending owner, always, in every method here. Two transactions that touch
   * the same pair of accounts from opposite ends would otherwise each hold what
   * the other is waiting for, and the database would break the tie by killing
   * one of them at random.
   */
  private async lock(tx: postgres.TransactionSql, owners: string[]) {
    const sorted = [...new Set(owners.map(lower))].sort()
    /*
     * Open each account at zero first, so the balance change below is a plain
     * UPDATE.
     *
     * The obvious idiom, `INSERT (owner, delta) ON CONFLICT DO UPDATE SET
     * balance = balance + EXCLUDED.balance`, is wrong here and was shipped:
     * Postgres evaluates a CHECK against the row being INSERTED, before it
     * detects the conflict, so a debit of 1,025 from an account holding 50,000
     * is rejected for proposing a row of -1,025. Every funding would have
     * failed with a 500. The account that has to exist is created empty, which
     * no constraint objects to.
     */
    for (const owner of sorted) {
      await tx`
        INSERT INTO credit_balances (owner, balance) VALUES (${owner}, 0)
        ON CONFLICT (owner) DO NOTHING
      `
    }
    await tx`
      SELECT owner FROM credit_balances
      WHERE owner = ANY(${sorted}) ORDER BY owner FOR UPDATE
    `
  }

  /**
   * One side of a movement: the entry, and the balance it moves.
   *
   * Private on purpose. Nothing outside this class may write a single side,
   * because a lone entry is how the ledger stopped balancing in the first
   * place. The two public writers below each call it exactly twice.
   */
  private async post(
    tx: postgres.TransactionSql,
    owner: string,
    delta: number,
    reason: string,
    reference: string | null,
    detail: Record<string, unknown>,
  ) {
    await tx`
      INSERT INTO credit_entries (id, owner, delta, reason, reference, detail)
      VALUES (${randomUUID()}, ${lower(owner)}, ${delta}, ${reason}, ${reference},
              ${tx.json(detail as postgres.JSONValue)})
    `
    // The account exists, because every caller locks it first. The check
    // constraint is evaluated on the result of this, which is the number that
    // matters, rather than on a proposed row that was never going to be stored.
    const rows = await tx<{ balance: string }[]>`
      UPDATE credit_balances SET balance = balance + ${delta}, updated_at = now()
       WHERE owner = ${lower(owner)}
      RETURNING balance
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
      await this.lock(tx, [input.owner, ISSUANCE_ACCOUNT])
      try {
        const balance = await this.post(
          tx,
          input.owner,
          input.points,
          input.reason,
          input.reference,
          input.detail ?? {},
        )
        // Issued out of an account that goes negative by exactly what is owed.
        await this.post(
          tx,
          ISSUANCE_ACCOUNT,
          -input.points,
          input.reason,
          `${input.reference}:src`,
          { issuedTo: lower(input.owner) },
        )
        return balance
      } catch (error) {
        // The unique index on reference is the thing stopping one payment being
        // credited twice; a retry after a timeout must not mint points.
        if ((error as { code?: string }).code === '23505')
          throw new DuplicateDeposit(input.reference)
        throw error
      }
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
       * would be free.
       */
      await this.lock(tx, [input.owner, REVENUE_ACCOUNT])
      const held = await tx<{ balance: string }[]>`
        SELECT balance FROM credit_balances WHERE owner = ${lower(input.owner)}
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
          await this.post(
            tx,
            input.owner,
            -charged,
            input.reason,
            input.reference ?? null,
            input.detail ?? {},
          )
          // The other side. What was taken paid for something, and this is the
          // account that says so.
          await this.post(
            tx,
            REVENUE_ACCOUNT,
            charged,
            input.reason,
            input.reference ? `${input.reference}:dst` : null,
            { spentBy: lower(input.owner) },
          )
        } catch (error) {
          // The unique index on reference is what makes a charge happen once.
          if ((error as { code?: string }).code === '23505' && input.reference)
            throw new DuplicateCharge(input.reference)
          throw error
        }
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
      await this.lock(tx, [input.from, input.to])

      const held = await tx<{ balance: string }[]>`
        SELECT balance FROM credit_balances WHERE owner = ${lower(input.from)}
      `
      const fromBalance = Number(held[0]?.balance ?? 0)
      /*
       * Issuance is the only account that may go below zero, because its
       * negative balance is the meaning of the account. Everything else,
       * escrow included, is refused: an escrow that can be overdrawn pays out
       * money nobody put in, which is the failure this whole file guards.
       */
      if (lower(input.from) !== ISSUANCE_ACCOUNT && fromBalance < input.points)
        throw new InsufficientBalance(input.points, fromBalance)

      try {
        const detail = input.detail ?? {}
        const nextFrom = await this.post(
          tx,
          input.from,
          -input.points,
          input.reason,
          `${input.reference}:out`,
          detail,
        )
        const nextTo = await this.post(
          tx,
          input.to,
          input.points,
          input.reason,
          `${input.reference}:in`,
          detail,
        )
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
         AND owner NOT LIKE 'aiki:%'
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
