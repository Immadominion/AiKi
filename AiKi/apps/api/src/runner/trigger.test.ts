import { expect, it } from 'vitest'
import { WAD } from '../reference/venus/types.js'
import { type Assessment, decide, repayToReach } from './trigger.js'

const base = (over: Partial<Assessment> = {}): Assessment => ({
  status: 'AT_RISK',
  healthFactor: '1.10',
  minimumHealthFactor: '1.25',
  adjustedCollateral: { amount: (1_100n * WAD).toString() },
  borrowed: { amount: (1_000n * WAD).toString() },
  consistency: { verified: true, detail: 'ok' },
  observedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const headroom = { remaining: 10_000n * WAD, price: WAD }

it('acts on a position at risk, and repays past the threshold rather than onto it', () => {
  const decision = decide(base(), headroom)
  expect(decision.act).toBe(true)
  if (!decision.act) return
  // 1100/1.25 = 880 permitted, so 120 of shortfall, plus 2% of it.
  expect(decision.repay).toBe(120n * WAD + (120n * WAD) / 50n)
})

it('never acts on an assessment that disagrees with the protocol', () => {
  // The assessment itself says no automation decision should use it. Spending
  // money on a reading we have already published as unreliable is the worst
  // thing this function could do.
  const decision = decide(
    base({ consistency: { verified: false, detail: 'differs by 4e17 units' } }),
    headroom,
  )
  expect(decision.act).toBe(false)
  expect(decision.reason).toContain('inconsistent')
})

it('leaves a healthy position alone', () => {
  for (const status of ['SAFE', 'NO_DEBT', 'NO_POSITION'])
    expect(decide(base({ status }), headroom).act).toBe(false)
})

it('refuses to guess at a status it does not recognise', () => {
  const decision = decide(base({ status: 'SOMETHING_NEW' }), headroom)
  expect(decision.act).toBe(false)
  expect(decision.reason).toContain('refusing to guess')
})

it('does not repay the same shortfall twice while the first repayment settles', () => {
  const now = Date.parse('2026-01-01T00:10:00.000Z')
  const recent = decide(base(), { ...headroom, lastActedAt: '2026-01-01T00:09:00.000Z' }, now)
  expect(recent.act).toBe(false)
  expect(recent.reason).toContain('waiting')

  const later = decide(base(), { ...headroom, lastActedAt: '2026-01-01T00:00:00.000Z' }, now)
  expect(later.act).toBe(true)
})

it('spends what the mandate allows and says the fix is partial', () => {
  const decision = decide(base(), { remaining: 50n * WAD, price: WAD })
  expect(decision.act).toBe(true)
  if (!decision.act) return
  expect(decision.repay).toBe(50n * WAD)
  expect(decision.reason).toContain('less than')
})

it('stops rather than acting when the mandate is exhausted', () => {
  const decision = decide(base(), { remaining: 0n, price: WAD })
  expect(decision.act).toBe(false)
  expect(decision.reason).toContain('no headroom')
})

it('computes a repayment that actually reaches the target', () => {
  const collateral = 1_100n * WAD
  const borrowed = 1_000n * WAD
  const target = (125n * WAD) / 100n
  const repay = repayToReach(collateral, borrowed, target)
  const after = ((borrowed - repay) * WAD) / WAD
  // The resulting health factor must be at or above the target, not near it.
  expect((collateral * WAD) / after >= target).toBe(true)
  expect(repayToReach(collateral, 800n * WAD, target)).toBe(0n)
})

it('repays in the token, not in dollars', () => {
  /*
   * The live BSC testnet case, which is the one that exposes this: USDT has six
   * decimals and the testnet oracle prices it at $0.50, so the position's
   * numbers and the mandate's numbers differ by eighteen decimal places AND by
   * a factor of two. $400 of collateral against $370 of debt needs $50 repaid to
   * reach 1.25, plus the 2% overshoot, which is $51 — and $51 is 102 USDT.
   *
   * With the amount left in dollars this asks for 51e18 base units of a
   * six-decimal token: fifty-one trillion USDT, overstated by 5e11, refused by
   * the cap on every pass forever. An 18-decimal token worth exactly $1 makes
   * the two units identical and hides all of it, which is why every other test
   * here passed while the agent could not have worked.
   */
  const decision = decide(
    {
      status: 'AT_RISK',
      minimumHealthFactor: '1.25',
      adjustedCollateral: { amount: (400n * WAD).toString() },
      borrowed: { amount: (370n * WAD).toString() },
      consistency: { verified: true, detail: 'ok' },
      observedAt: '2026-08-30T00:00:00.000Z',
    },
    { remaining: 1_000_000_000n, price: 5n * 10n ** 29n },
  )
  expect(decision.act).toBe(true)
  if (!decision.act) return
  expect(decision.repay).toBe(102_000_000n)
})

it('will not guess an amount without a price', () => {
  const decision = decide(base(), { remaining: 10_000n * WAD, price: 0n })
  expect(decision.act).toBe(false)
})
