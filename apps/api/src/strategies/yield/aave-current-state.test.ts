import { describe, expect, it } from 'vitest'
import { decideYield } from '../yield-planner.js'
import { yieldPlannerFixture } from '../yield-planner.test-support.js'
import { YIELD_RAY as R, supplyRateAfter } from './rates.js'

// Public reads from canonical BSC block121099421, with later local-fork snapshot
// timestamp1789056536 (39s after the reserve's stored update). The pinned deployed
// model reproduced both reference rates via explicit read-only parameter calls.
const CASH = 10398403031041136418141934n,
  DEBT = 48867246976058422143354974n,
  DEFICIT = 1498702276233149882n,
  CURRENT = 29914538516355884700249065n,
  CACHED = 29914537993046030684626053n,
  WITHOUT_DEFICIT = 29914539272830958567761859n

function fixture() {
  const f = yieldPlannerFixture(),
    aave = f.snapshot.venues.aave
  if (!aave.model || aave.model.kind === 'venus-two-kinks') throw Error('Invalid fixture model')
  Object.assign(aave, {
    cash: CASH,
    virtualCash: CASH,
    debt: DEBT,
    deficit: DEFICIT,
    currentStateSupplyRate: CURRENT,
    storedRateTimestamp: f.snapshot.block.timestamp - 39,
    observedSupplyRate: CACHED,
    model: {
      ...aave.model,
      kind: 'aave-v3-two-slope',
      baseBorrowRate: 0n,
      slopeBelowKink: 44n * 10n ** 24n,
      slopeAboveKink: 100n * 10n ** 24n,
      kinkWad: 9n * 10n ** 17n,
    },
  })
  f.policy.rateToleranceRay = 10n ** 18n
  return { ...f, aave }
}

describe('Aave accrued-debt and deficit-aware rate validation', () => {
  it('matches the pinned model with separate borrow and deficit-diluted supply usage', () => {
    const { snapshot, policy, aave } = fixture()
    expect(supplyRateAfter(aave, 0n, snapshot.block, policy)).toBe(CURRENT)
    expect(supplyRateAfter({ ...aave, deficit: 0n }, 0n, snapshot.block, policy)).toBe(
      WITHOUT_DEFICIT,
    )
  })
  it('reproduces the cached rate only using the stored-index debt basis and deficit', () => {
    const { snapshot, policy, aave } = fixture(),
      scaledDebt = 41527289557957161745249686n,
      storedIndex = 1176750157790220210716922368n,
      storedDebt = (scaledDebt * storedIndex + R - 1n) / R
    expect(storedDebt).toBe(48867244539926254187988521n)
    expect(supplyRateAfter({ ...aave, debt: storedDebt }, 0n, snapshot.block, policy)).toBe(CACHED)
    expect(aave.debt).toBe(DEBT)
  })
  it('validates current state without rejecting legitimate stored-rate accrual drift', () => {
    const { snapshot, policy, aave } = fixture()
    // The reference, not a relaxed tolerance, decides whether the curve reproduces state.
    // A longer idle reserve may legitimately have a much older cached liquidity rate.
    aave.observedSupplyRate = CACHED - 10n ** 21n
    const decision = decideYield(snapshot, policy, {}, snapshot.block.timestamp)
    expect(decision.code).toBe('QUOTE_REQUIRED')
    expect(decision.act).toBe(false)
    expect(policy.rateToleranceRay).toBe(10n ** 18n)
    expect(aave.debt).toBe(DEBT)
    expect(aave.observedSupplyRate).toBe(CACHED - 10n ** 21n)
  })
  it('still refuses a current-state contract reference outside the unchanged tolerance', () => {
    const { snapshot, policy, aave } = fixture()
    Object.assign(aave, { currentStateSupplyRate: CURRENT + policy.rateToleranceRay + 1n })
    expect(decideYield(snapshot, policy, {}, snapshot.block.timestamp).code).toBe('RATE_MISMATCH')
  })
  it.each([
    { currentStateSupplyRate: undefined },
    { currentStateSupplyRate: null },
    { currentStateSupplyRate: -1n },
    { storedRateTimestamp: undefined },
    { storedRateTimestamp: -1 },
    { storedRateTimestamp: 1_000_001 },
    { deficit: undefined },
    { deficit: -1n },
  ])('fails closed for missing or malformed current-state evidence case %#', (change) => {
    const { snapshot, policy, aave } = fixture()
    Object.assign(aave, change)
    expect(decideYield(snapshot, policy, {}, snapshot.block.timestamp).code).toBe(
      'INCONSISTENT_SNAPSHOT',
    )
  })
  it('does not reinterpret unsupported legacy unbacked or stable debt as the new deficit field', () => {
    const { snapshot, policy, aave } = fixture()
    expect(supplyRateAfter({ ...aave, unbacked: 1n }, 0n, snapshot.block, policy)).toBeNull()
    expect(supplyRateAfter({ ...aave, stableDebt: 1n }, 0n, snapshot.block, policy)).toBeNull()
    const unknown = structuredClone(aave)
    if (!unknown.model || unknown.model.kind === 'venus-two-kinks')
      throw Error('Invalid fixture model')
    unknown.model.kind = 'reviewed-two-slope'
    expect(supplyRateAfter(unknown, 0n, snapshot.block, policy)).toBeNull()
  })
})
