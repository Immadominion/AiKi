import { expect, it } from 'vitest'
import { ESCROW_ACCOUNT, InMemoryCreditStore, ISSUANCE_ACCOUNT, REVENUE_ACCOUNT } from './store.js'

/*
 * Points are moved, never created or destroyed.
 *
 * Measured on production before this held: six reasons had moved points and not
 * one summed to zero, because a deposit credited somebody from nowhere and a
 * charge deleted points into nowhere. The damage was not theoretical. A buyer
 * was debited 2,050 points that arrived in no account, and because the totals
 * still looked plausible, a job that had taken money and paid nobody was
 * indistinguishable from a job that had settled correctly.
 *
 * Every account in the system, house accounts included, must sum to zero after
 * any sequence of operations. That is the whole property.
 */

const BUYER = `0x${'ab'.repeat(20)}`
const SELLER = `0x${'cd'.repeat(20)}`
const TREASURY = `0x${'ef'.repeat(20)}`

async function everything(credits: InMemoryCreditStore) {
  const owners = [BUYER, SELLER, TREASURY, ISSUANCE_ACCOUNT, REVENUE_ACCOUNT, ESCROW_ACCOUNT]
  const balances = await Promise.all(owners.map((o) => credits.balance(o)))
  return balances.reduce((a, b) => a + b, 0)
}

it('is still balanced after a whole sale', async () => {
  const credits = new InMemoryCreditStore()
  expect(await everything(credits)).toBe(0)

  // Issued.
  await credits.deposit({ owner: BUYER, points: 50_000, reason: 'deposit', reference: '0xtx' })
  await credits.deposit({
    owner: BUYER,
    points: 5_000,
    reason: 'welcome',
    reference: `welcome:${BUYER}`,
  })
  expect(await everything(credits)).toBe(0)
  // What was issued is what the issuance account owes, to the point.
  expect(await credits.balance(ISSUANCE_ACCOUNT)).toBe(-55_000)

  // Consumed by a model turn AiKi pays a provider for.
  await credits.charge({ owner: BUYER, points: 1_376, reason: 'fast_mode' })
  expect(await everything(credits)).toBe(0)
  expect(await credits.balance(REVENUE_ACCOUNT)).toBe(1_376)

  // Funded, held, and paid out.
  await credits.transfer({
    from: BUYER,
    to: ESCROW_ACCOUNT,
    points: 1_025,
    reason: 'job_funding',
    reference: 'job:one:funding',
  })
  // The money exists somewhere between the two halves of the sale, which is the
  // thing that was not true: a funded job's money was in no account at all.
  expect(await credits.balance(ESCROW_ACCOUNT)).toBe(1_025)
  expect(await everything(credits)).toBe(0)

  await credits.transfer({
    from: ESCROW_ACCOUNT,
    to: SELLER,
    points: 1_000,
    reason: 'job_earnings',
    reference: 'job:one:job_earnings',
  })
  await credits.transfer({
    from: ESCROW_ACCOUNT,
    to: TREASURY,
    points: 25,
    reason: 'platform_fee',
    reference: 'job:one:platform_fee',
  })

  expect(await everything(credits)).toBe(0)
  expect(await credits.balance(ESCROW_ACCOUNT)).toBe(0)
  expect(await credits.balance(BUYER)).toBe(52_599)
  expect(await credits.balance(SELLER)).toBe(1_000)
})

it('is still balanced when a charge overruns the balance', async () => {
  /*
   * The clamping path writes a different number from the one it was asked for,
   * and the counterparty has to receive that number and not the requested one.
   * Crediting the ask while debiting what was available would balance on the
   * happy path and quietly mint the shortfall on this one.
   */
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: BUYER, points: 100, reason: 'deposit', reference: '0xa' })
  const out = await credits.charge({ owner: BUYER, points: 250, reason: 'fast_mode' })

  expect(out.charged).toBe(100)
  expect(out.shortfall).toBe(150)
  expect(await credits.balance(REVENUE_ACCOUNT)).toBe(100)
  expect(await everything(credits)).toBe(0)
})

it('will not let escrow pay out money nobody funded', async () => {
  /*
   * Issuance may go negative because its negative balance is the liability it
   * exists to name. Escrow may not: an overdrawn escrow means a payout drew on
   * a funding that never happened, which is other buyers' money.
   */
  const credits = new InMemoryCreditStore()
  await expect(
    credits.transfer({
      from: ESCROW_ACCOUNT,
      to: SELLER,
      points: 1_000,
      reason: 'job_earnings',
      reference: 'job:never-funded:job_earnings',
    }),
  ).rejects.toThrow()
  expect(await everything(credits)).toBe(0)
})
