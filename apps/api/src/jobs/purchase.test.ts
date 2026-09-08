import { expect, it } from 'vitest'
import type { Constraint } from '../authority/policy.js'
import { SETTLEMENT } from '../settlement/pricing.js'
import { JobService } from './service.js'
import { InMemoryJobStore } from './store.js'

/*
 * A mandate decides whether a hire may happen, and what it costs counts.
 *
 * It did not, and that is the finding this file exists for. Neither money route
 * consulted the authorization it ran under: a revoked mandate still funded, an
 * expired one still funded, and the price of a hire counted against no cap at
 * all. Contract-enforced limits are the thing AiKi is for, and the one route
 * that spends money went round them.
 *
 * Amounts here are base units of an eighteen-decimal settlement asset, which is
 * what caps are written in. A tenth of a token is 10^17.
 */

const TENTH = 100_000_000_000_000_000n
const OWNER = `0x${'ab'.repeat(20)}`

/**
 * The asset AiKi settles in. A mandate has to name it, or its caps are
 * denominated in something else and cannot govern a purchase here.
 */
const U = SETTLEMENT.address

const cap = (total: bigint): Constraint[] => [
  { kind: 'asset_scope', value: [U], tier: 'T1', label: 'Settles in U' },
  { kind: 'session_total_cap', value: total.toString(), tier: 'T1', label: 'Lifetime cap' },
]

const service = () => new JobService(new InMemoryJobStore())

it('refuses to pay for anything under a revoked mandate', async () => {
  const jobs = service()
  const auth = await jobs.authorize(cap(TENTH * 10n), OWNER)
  await jobs.revoke(auth.id)

  const verdict = await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)
  expect(verdict.allow).toBe(false)
  expect(verdict.rule).toBe('authorization_status')
  // Revoking is the one control a person has after the fact, and a revoked
  // mandate that still spends is not a control.
  expect(verdict.reason).toMatch(/revoked/)
})

it('refuses to pay for anything under an expired mandate', async () => {
  const jobs = service()
  const auth = await jobs.authorize(
    [
      { kind: 'expiry', value: '2020-01-01T00:00:00.000Z', tier: 'T1', label: 'Expiry' },
      ...cap(TENTH * 10n),
    ],
    OWNER,
  )

  const verdict = await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)
  expect(verdict.allow).toBe(false)
  expect(verdict.rule).toBe('expiry')
})

it('counts what a hire costs against the lifetime cap', async () => {
  const jobs = service()
  // Room for two hires at a tenth each, and not a third.
  const auth = await jobs.authorize(cap(TENTH * 2n), OWNER)

  expect((await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)).allow).toBe(true)
  expect((await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)).allow).toBe(true)

  const third = await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)
  expect(third.allow).toBe(false)
  expect(third.rule).toBe('session_total_cap')
  // Refused, so nothing was counted for it: a denial must not eat the allowance.
  expect((await jobs.getAuthorization(auth.id)).spent).toBe(TENTH * 2n)
})

it('refuses a single hire bigger than the per-action cap', async () => {
  const jobs = service()
  const auth = await jobs.authorize(
    [
      { kind: 'per_action_cap', value: TENTH.toString(), tier: 'T1', label: 'Per action' },
      ...cap(TENTH * 100n),
    ],
    OWNER,
  )

  const verdict = await jobs.attemptPurchase(auth.id, TENTH * 2n, new Date().toISOString(), U)
  expect(verdict.allow).toBe(false)
  expect(verdict.rule).toBe('per_action_cap')
})

it('does not refuse a hire because the mandate names a contract', async () => {
  /*
   * A contract allowlist and a selector allowlist describe calls the agent may
   * make on chain. Paying for the agent is not one of them, and refusing a hire
   * because the mandate names a lending market would be enforcing a rule
   * against something it was never written about. Every mandate in the product
   * carries these, so getting this wrong would refuse every hire.
   */
  const jobs = service()
  const auth = await jobs.authorize(
    [
      {
        kind: 'contract_allowlist',
        value: ['0xfd36e2c2a6789db23113685031d7f16329158384'],
        tier: 'T0',
        label: 'Venus only',
      },
      { kind: 'selector_allowlist', value: ['0x0e752702'], tier: 'T0', label: 'Repay only' },
      ...cap(TENTH * 10n),
    ],
    OWNER,
  )

  expect((await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)).allow).toBe(true)
})

it('gives the cap back when a hire is refunded', async () => {
  // A buyer who funds and cancels ten times has spent nothing, and their
  // allowance should say so.
  const jobs = service()
  const auth = await jobs.authorize(cap(TENTH), OWNER)

  expect((await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)).allow).toBe(true)
  await jobs.releaseSpend(auth.id, TENTH)
  expect((await jobs.getAuthorization(auth.id)).spent).toBe(0n)

  // And the allowance is genuinely usable again, not merely reported as zero.
  expect((await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)).allow).toBe(true)
})

it('will not spend a budget denominated in another currency', async () => {
  /*
   * The nearest real example, and the reason this check exists. Fast mode
   * builds a lending mandate capped in a six-decimal testnet USDT. The
   * marketplace settles in an eighteen-decimal asset. Those two numbers differ
   * by 10^12 before anybody has spent anything, and there is no oracle here to
   * convert one into the other, so a cap of "100 USDT" says nothing whatever
   * about whether a hire priced in U is allowed.
   */
  const jobs = service()
  const testnetUsdt = '0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c'
  const auth = await jobs.authorize(
    [
      { kind: 'asset_scope', value: [testnetUsdt], tier: 'T0', label: 'Only USDT' },
      { kind: 'session_total_cap', value: '100000000', tier: 'T0', label: '100 USDT in total' },
    ],
    OWNER,
  )

  const verdict = await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)
  expect(verdict.allow).toBe(false)
  expect(verdict.rule).toBe('asset_scope')
  // Refused, not waved through. An unpinned cap is an absent one, and this is
  // the route that spends money.
  expect((await jobs.getAuthorization(auth.id)).spent).toBe(0n)
})

it('will not spend under a mandate that names no asset at all', async () => {
  const jobs = service()
  const auth = await jobs.authorize(
    [{ kind: 'session_total_cap', value: (TENTH * 10n).toString(), tier: 'T1', label: 'Cap' }],
    OWNER,
  )
  const verdict = await jobs.attemptPurchase(auth.id, TENTH, new Date().toISOString(), U)
  expect(verdict.allow).toBe(false)
  expect(verdict.reason).toMatch(/names no asset/)
})
