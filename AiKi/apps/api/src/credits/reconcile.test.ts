import postgres from 'postgres'
import { afterAll, expect, it } from 'vitest'
import { checkLedger } from './reconcile.js'
import { ESCROW_ACCOUNT, PostgresCreditStore } from './store.js'

/*
 * The same property, through the code production actually runs.
 *
 * The in-memory store agreeing with itself proves nothing about Postgres: the
 * two implementations were written separately, and it was the Postgres one that
 * shipped a single-sided ledger to a live system. These run against a real
 * database or they skip, loudly, rather than reporting a pass for a test that
 * returned early.
 */

const databaseUrl = process.env.DATABASE_URL
const sql = databaseUrl ? postgres(databaseUrl, { max: 2 }) : null

afterAll(async () => {
  await sql?.end()
})

/** Unique per run, so an accumulating test database cannot make this flaky. */
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const net = async (db: postgres.Sql) => {
  const [row] = await db<
    { net: string }[]
  >`SELECT coalesce(sum(delta), 0) AS net FROM credit_entries`
  return Number(row?.net ?? 0)
}

it.skipIf(!databaseUrl)('moves points without creating or destroying any', async () => {
  const db = sql as postgres.Sql
  const credits = new PostgresCreditStore(databaseUrl as string)
  const run = stamp()
  const buyer = `0x${run.padEnd(40, '0').slice(0, 40)}`
  const seller = `0x${run.padEnd(40, '1').slice(0, 40)}`

  /*
   * Measured as a difference rather than an absolute, because a shared test
   * database carries whatever earlier runs left behind. The claim being tested
   * is that these operations move the total by nothing at all.
   */
  const before = await net(db)

  await credits.deposit({
    owner: buyer,
    points: 5_000,
    reason: 'welcome',
    reference: `welcome:${run}`,
  })
  await credits.charge({ owner: buyer, points: 400, reason: 'fast_mode' })
  await credits.transfer({
    from: buyer,
    to: ESCROW_ACCOUNT,
    points: 1_025,
    reason: 'job_funding',
    reference: `job:${run}:funding`,
  })
  await credits.transfer({
    from: ESCROW_ACCOUNT,
    to: seller,
    points: 1_000,
    reason: 'job_earnings',
    reference: `job:${run}:job_earnings`,
  })
  // Both legs, so escrow is left holding nothing. A sale that pays the seller
  // and forgets the fee leaves money in escrow against no job, which is the
  // condition the fifth check exists to catch, and it does catch this.
  await credits.transfer({
    from: ESCROW_ACCOUNT,
    to: `0x${run.padEnd(40, '3').slice(0, 40)}`,
    points: 25,
    reason: 'platform_fee',
    reference: `job:${run}:platform_fee`,
  })

  expect(await net(db)).toBe(before)
  expect(await credits.balance(buyer)).toBe(3_575)
  expect(await credits.balance(seller)).toBe(1_000)
  await credits.close()
})

it.skipIf(!databaseUrl)('refuses to let escrow go below zero', async () => {
  // The database constraint, not a comparison in TypeScript: escrow paying out
  // more than was funded is other buyers' money, and it has to be refused by
  // the same thing that refuses two writers at once.
  const credits = new PostgresCreditStore(databaseUrl as string)
  const run = stamp()
  await expect(
    credits.transfer({
      from: ESCROW_ACCOUNT,
      to: `0x${run.padEnd(40, '2').slice(0, 40)}`,
      points: 10_000_000,
      reason: 'job_earnings',
      reference: `job:${run}:never-funded`,
    }),
  ).rejects.toThrow()
  await credits.close()
})

it.skipIf(!databaseUrl)('reports on the ledger it is pointed at', async () => {
  const findings = await checkLedger(sql as postgres.Sql)
  // Every check reports its numbers whether it passed or not, because a check
  // that only speaks up on failure cannot be used to show that things are fine.
  expect(findings.length).toBeGreaterThanOrEqual(6)
  for (const finding of findings) expect(finding.detail).not.toBe('')
})
