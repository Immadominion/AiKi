import type postgres from 'postgres'
import { ESCROW_ACCOUNT, ISSUANCE_ACCOUNT, RESERVE_ACCOUNT } from './store.js'

/**
 * Does the money add up.
 *
 * Not a test. A question anybody running AiKi should be able to ask of the live
 * database at any moment and get a yes to, because the alternative is finding
 * out from a person whose points went missing.
 *
 * It exists because the answer was no and nobody could have known. Production
 * had six reasons that had moved points and not one of them summed to zero: a
 * buyer had been debited 2,050 points that arrived in no account, a seller had
 * been paid 1,025 that came from no account, and the totals happened to look
 * plausible the whole time. Every check below is one of those failures written
 * down so it cannot recur silently.
 */

export interface LedgerFinding {
  /** What was asked. */
  check: string
  ok: boolean
  /** The numbers, always, whether it passed or failed. */
  detail: string
}

const n = (value: unknown) => Number(value ?? 0)

export async function checkLedger(
  sql: postgres.Sql,
  /**
   * What the treasury actually holds, in points.
   *
   * Passed in rather than read here, because it lives on a chain and this file
   * reads a database. Absent means the deployment cannot see its own treasury,
   * which is reported as a failed check and not as a passed one: an unverified
   * solvency claim and a verified one must not look the same.
   */
  backingPoints?: number | null,
): Promise<LedgerFinding[]> {
  const findings: LedgerFinding[] = []

  /*
   * The one that matters most. Points are moved, never created or destroyed, so
   * the sum over every account of every movement ever made is zero. A non-zero
   * total is money that came from nowhere or went nowhere, and it does not
   * matter which: both mean the record is not a record of anything.
   */
  const [total] = await sql<
    { net: string }[]
  >`SELECT coalesce(sum(delta), 0) AS net FROM credit_entries`
  findings.push({
    check: 'the whole ledger nets to zero',
    ok: n(total?.net) === 0,
    detail: `net ${n(total?.net)} points across every entry`,
  })

  /*
   * The same question per reason, which is what localises a break. "Funding
   * does not balance" points at one route; "the ledger does not balance" points
   * at the whole system.
   */
  const reasons = await sql<{ reason: string; net: string; entries: string }[]>`
    SELECT reason, sum(delta) AS net, count(*) AS entries
      FROM credit_entries GROUP BY reason ORDER BY reason
  `
  const unbalanced = reasons.filter((r) => n(r.net) !== 0)
  findings.push({
    check: 'every reason nets to zero',
    ok: unbalanced.length === 0,
    detail: unbalanced.length
      ? unbalanced.map((r) => `${r.reason} is off by ${n(r.net)}`).join(', ')
      : `${reasons.length} reasons, all balanced`,
  })

  /*
   * The balance column is a cache of the entries and is allowed to be nothing
   * else. If it has drifted, every screen showing somebody their points is
   * showing a number the ledger does not support.
   */
  const drifted = await sql<{ owner: string; balance: string; entries: string }[]>`
    SELECT b.owner, b.balance, coalesce(e.net, 0) AS entries
      FROM credit_balances b
      LEFT JOIN (SELECT owner, sum(delta) AS net FROM credit_entries GROUP BY owner) e
        ON e.owner = b.owner
     WHERE b.balance <> coalesce(e.net, 0)
  `
  findings.push({
    check: 'every balance equals the entries behind it',
    ok: drifted.length === 0,
    detail: drifted.length
      ? drifted
          .map((d) => `${d.owner} shows ${n(d.balance)} and sums to ${n(d.entries)}`)
          .join(', ')
      : 'no account has drifted from its history',
  })

  /*
   * Issuance is meant to be negative: it is what AiKi has handed out. Any other
   * negative account is an overdraft, and the one that would hurt is escrow,
   * because escrow going below zero means a payout drew on money nobody funded.
   */
  const negative = await sql<{ owner: string; balance: string }[]>`
    SELECT owner, balance FROM credit_balances
     WHERE balance < 0 AND owner <> ${ISSUANCE_ACCOUNT}
  `
  findings.push({
    check: 'no account except issuance is overdrawn',
    ok: negative.length === 0,
    detail: negative.length
      ? negative.map((a) => `${a.owner} is at ${n(a.balance)}`).join(', ')
      : 'every account is at or above zero',
  })

  /*
   * What escrow holds should be exactly what the marketplace owes: the total of
   * jobs that have been paid for and not yet settled or returned. This is the
   * check that would have caught the stuck 2,050 points on the day they stuck,
   * rather than a fortnight later during an audit.
   */
  const [held] = await sql<{ balance: string }[]>`
    SELECT balance FROM credit_balances WHERE owner = ${ESCROW_ACCOUNT}
  `
  const [owed] = await sql<{ owed: string; jobs: string }[]>`
    SELECT coalesce(sum(sold_total_points), 0) AS owed, count(*) AS jobs
      FROM jobs WHERE status = 'FUNDED'
  `
  /*
   * Tasks draw on the same escrow, so they have to be counted here or this check
   * turns red the first time somebody posts work. Money is held from the moment
   * a task is funded until it is accepted or taken back: OPEN and CLAIMED and
   * SUBMITTED are all "somebody is owed this", and so is DISPUTED, which is the
   * whole point of a dispute. SETTLED has been paid out and CANCELLED refunded.
   */
  const [tasksOwed] = await sql<{ owed: string; tasks: string }[]>`
    SELECT coalesce(sum(total_points), 0) AS owed, count(*) AS tasks
      FROM tasks WHERE status IN ('OPEN', 'CLAIMED', 'SUBMITTED', 'DISPUTED')
  `
  const commitments = n(owed?.owed) + n(tasksOwed?.owed)
  findings.push({
    check: 'escrow holds exactly what is owed on funded work',
    ok: n(held?.balance) === commitments,
    detail: `escrow holds ${n(held?.balance)}; ${n(owed?.jobs)} funded jobs owe ${n(owed?.owed)} and ${n(tasksOwed?.tasks)} live tasks owe ${n(tasksOwed?.owed)}`,
  })

  /*
   * A funded job with no recorded terms is money nobody can move.
   *
   * Both payout routes read the sale off the job to decide who is paid and how
   * much, and refuse when it is missing, which is right: guessing is how a
   * settlement pays the wrong address. But it means such a job is stuck, and
   * the check above cannot see it, because a job owed nothing matches an escrow
   * holding nothing. This is the condition that stranded 2,050 real points.
   */
  const termless = await sql<{ id: string }[]>`
    SELECT id FROM jobs WHERE status = 'FUNDED' AND sold_agent_id IS NULL
  `
  findings.push({
    check: 'every funded job records what was bought',
    ok: termless.length === 0,
    detail: termless.length
      ? `${termless.length} funded with no terms, so no route can settle or refund them: ${termless
          .map((j) => j.id)
          .join(', ')}`
      : 'no funded job is missing its terms',
  })

  /*
   * A hold is taken when a Fast mode turn starts and resolved when it ends,
   * both inside one request. Anything still held an hour later is money taken
   * from somebody for work that is long over: the process died between taking
   * it and accounting for it. It is recoverable precisely because both legs
   * carry the turn id, and this is what finds it.
   */
  const stuck = await sql<{ turn: string; held: string }[]>`
    SELECT split_part(reference, ':', 2) AS turn, sum(delta) AS held
      FROM credit_entries
     WHERE owner = ${RESERVE_ACCOUNT}
       AND reference LIKE 'turn:%'
       AND created_at < now() - interval '1 hour'
     GROUP BY 1 HAVING sum(delta) <> 0
  `
  findings.push({
    check: 'no turn is still holding money it never used',
    ok: stuck.length === 0,
    detail: stuck.length
      ? stuck.map((h) => `turn ${h.turn} still holds ${n(h.held)}`).join(', ')
      : 'every hold taken for a turn has been resolved',
  })

  /*
   * Is there money behind the points people hold.
   *
   * Points are sold for a token that sits in a treasury, and they are also given
   * away: a welcome grant mints points against no deposit at all, deliberately,
   * because it is cheaper than losing every visitor at a payment screen. That
   * makes AiKi's obligations larger than its deposits BY DESIGN, and the honest
   * thing is to say by how much rather than to leave it as something a person
   * would have to reconstruct from the ledger.
   *
   * What must hold is narrower and is the real promise: every point somebody
   * PAID for is still backed by the token they paid with. Granted points are a
   * marketing cost AiKi carries. Sold points are somebody else's money.
   */
  const [issued] = await sql<{ sold: string; granted: string }[]>`
    SELECT
      coalesce(-sum(delta) FILTER (WHERE reason = 'deposit'), 0) AS sold,
      coalesce(-sum(delta) FILTER (WHERE reason <> 'deposit'), 0) AS granted
    FROM credit_entries WHERE owner = ${ISSUANCE_ACCOUNT}
  `
  const sold = n(issued?.sold)
  const granted = n(issued?.granted)
  findings.push({
    check: 'every point somebody paid for is still backed',
    ok: typeof backingPoints === 'number' && backingPoints >= sold,
    detail:
      typeof backingPoints === 'number'
        ? `${sold} points sold and ${backingPoints} points of backing held; ${granted} more were granted, which AiKi carries`
        : `${sold} points sold and ${granted} granted, but the treasury could not be read, so this is unverified`,
  })

  return findings
}
