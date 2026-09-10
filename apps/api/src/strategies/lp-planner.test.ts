import { describe, expect, it, vi } from 'vitest'
import { assertStrategyEnvelope } from './envelope.js'
import { mulDiv, mulDivRoundingUp, quoteAtTick, sqrtRatioAtTick } from './grid/math.js'
import { amountsForLiquidity } from './lp/liquidity.js'
import type { VerifiedLPPoolState } from './lp/market.js'
import { a, h, L, LP_TEST_POLICY, lpFixture, NOW } from './lp/planner.test-support.js'
import { decideLP, type LPAtomicSimulator, lpRanges } from './lp-planner.js'
import type { StrategySimulationQuote } from './simulation.js'
import type { VerifiedStrategySnapshot } from './snapshot.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x6005') } }
})

describe('bounded full-atomic LP replacement planning', () => {
  it('prefers a zero-swap replacement and verifies the complete manager envelope', async () => {
    const f = lpFixture(),
      result = await f.run()
    expect(result.act).toBe(true)
    if (!result.act) throw new Error(result.code)
    expect(result.operation).toMatchObject({
      kind: 'lp',
      expectedNonce: 7n,
      expectedTokenId: 42n,
      tickLower: -100,
      tickUpper: 100,
      swapAmount: 0n,
      minSwapOut: 0n,
      sqrtPriceLimitX96: 0n,
    })
    expect(result.attemptedCandidates).toBe(1)
    expect(result.gasCostWei).toBe(1_200_000_000_000_000n)
    const call = f.simulationReader.call.mock.calls[0]?.[0]
    if (!call) throw new Error('Expected complete simulation')
    expect(call).toMatchObject({ account: a('66'), value: 0n, blockNumber: 100n })
    expect(call.to).not.toBe(result.operation.binding.vault)
    expect(() => assertStrategyEnvelope(call.data, result.operation, a('66'))).not.toThrow()
    expect(f.simulationReader.estimateGas).toHaveBeenCalledWith(call)
    expect(result.operation.minLiquidity).toBeGreaterThan(0n)
    const principal = amountsForLiquidity(1n << 96n, sqrtRatioAtTick(-300), sqrtRatioAtTick(300), L)
    expect(result.operation.minBurn0).toBe((principal[0] * 9900n) / 10000n)
    expect(result.operation.minBurn1).toBe((principal[1] * 9900n) / 10000n)
    expect(result.operation.minMint0).toBeGreaterThan(0n)
    expect(result.operation.minMint1).toBeGreaterThan(0n)
    expect(() => Object.assign(result.operation, { minLiquidity: 0n })).toThrow()
  })
  it.each([
    { lower: 100, upper: 300, zeroForOne: true },
    { lower: -300, upper: -100, zeroForOne: false },
  ])(
    'balances an out-of-range position with the exact-input direction $zeroForOne',
    async ({ lower, upper, zeroForOne }) => {
      const f = lpFixture({ lower, upper }),
        result = await f.run()
      expect(result.act).toBe(true)
      if (!result.act) throw new Error(result.code)
      const op = result.operation
      expect(op.zeroForOne).toBe(zeroForOne)
      expect(op.swapAmount).toBeGreaterThan(0n)
      expect(op.swapAmount).toBeLessThanOrEqual(100n * L)
      expect(op.minSwapOut).toBeGreaterThan(0n)
      const minInput = mulDivRoundingUp(op.swapAmount, 9500n, 10000n)
      const floor = mulDiv(
        mulDiv(
          quoteAtTick(0, minInput, zeroForOne ? a('71') : a('72'), zeroForOne ? a('72') : a('71')),
          999500n,
          1000000n,
        ),
        9900n,
        10000n,
      )
      expect(op.minSwapOut).toBeGreaterThanOrEqual(floor)
      expect(op.sqrtPriceLimitX96).toBe(sqrtRatioAtTick(zeroForOne ? -50 : 50))
      expect(f.simulationReader.call).toHaveBeenCalledTimes(result.attemptedCandidates)
    },
  )
  it('tries all eligible zero-swap candidates before fallback swap candidates', async () => {
    const f = lpFixture()
    // Force the *complete manager call* to revert for every no-swap candidate.
    f.simulate.mockImplementation(async (op, snapshot) => {
      if (op.swapAmount === 0n)
        return { status: 'blocked', reason: 'Full atomic simulation reverted.' }
      const other = lpFixture()
      return other.simulate(op, snapshot)
    })
    const result = await f.run()
    expect(result.act).toBe(true)
    const calls = f.simulate.mock.calls.map(([op]) => op.swapAmount)
    const firstSwap = calls.findIndex((amount) => amount > 0n)
    // This balanced inventory supports all three no-swap ranges. Check a non-vacuous
    // prefix, then the slightly offset ranges also supply nonzero balancing candidates.
    expect(firstSwap).toBe(3)
    expect(calls.slice(0, firstSwap).every((amount) => amount === 0n)).toBe(true)
  })
  it('does not churn a healthy position inside its configured range', async () => {
    const f = lpFixture({ lower: -100, upper: 100 })
    expect(await f.run()).toMatchObject({
      act: false,
      code: 'POSITION_HEALTHY',
      attemptedCandidates: 0,
    })
    expect(f.simulate).not.toHaveBeenCalled()
  })
  it.each([
    [{ paused: true }, 'PAUSED'],
    [{ expiresAt: NOW - 1n }, 'EXPIRED'],
    [{ lastExecutionAt: NOW - 59n }, 'COOLDOWN'],
    [{ blockTimestamp: NOW - 31n }, 'STALE_SNAPSHOT'],
    [{ blockTimestamp: NOW + 1n }, 'STALE_SNAPSHOT'],
    [{ expiresAt: NOW + 5n }, 'DEADLINE_TOO_CLOSE'],
  ] as const)('waits before simulation for lifecycle or freshness %s', async (options, code) => {
    const f = lpFixture(options)
    expect(await f.run()).toMatchObject({ act: false, code, attemptedCandidates: 0 })
    expect(f.simulate).not.toHaveBeenCalled()
  })
  it('caps deadline to the old finalized block, not now plus a full delay', async () => {
    const result = await lpFixture({ blockTimestamp: NOW - 25n }).run()
    expect(result.act).toBe(true)
    if (result.act) expect(result.operation.deadline).toBe(NOW + 95n)
  })
  it('requires a genuine snapshot and pool proof issued for the exact same object', async () => {
    const f = lpFixture(),
      state = await f.proofs(),
      other = await lpFixture().proofs()
    for (const input of [
      { ...state, snapshot: { ...state.snapshot } as VerifiedStrategySnapshot },
      { ...state, pool: { ...state.pool } as VerifiedLPPoolState },
      { ...state, pool: other.pool },
    ])
      expect(
        await decideLP({ ...input, policy: LP_TEST_POLICY, nowSeconds: NOW }, f.simulate),
      ).toMatchObject({ act: false, code: 'UNVERIFIED_STATE', attemptedCandidates: 0 })
  })
  it.each([
    ['maxSimulations', 13],
    ['maxSimulations', 0],
    ['maxSnapshotAgeSeconds', 31],
    ['swapSlippageBps', 101],
    ['liquiditySlippageBps', 101],
    ['maxSwapImpactTicks', 101],
    ['triggerEdgeTicks', 0],
    ['triggerEdgeTicks', 101],
    ['maxGasCostWei', 0n],
    ['simulationTimeoutMs', 0],
    ['deadlineSeconds', Number.NaN],
    ['poolRuntimeCodeHash', h('ab')],
  ])('refuses invalid planner limits %s', async (name, value) => {
    const f = lpFixture()
    expect(await f.run({ ...LP_TEST_POLICY, [String(name)]: value })).toMatchObject({
      act: false,
      code: 'INVALID_INPUT',
      attemptedCandidates: 0,
    })
    expect(f.simulate).not.toHaveBeenCalled()
  })
  it('refuses insufficient liquidity after removing the original in-range NFT', async () => {
    const f = lpFixture()
    f.poolValues.set('liquidity', L)
    expect(await f.run()).toMatchObject({
      act: false,
      code: 'INSUFFICIENT_REMAINING_LIQUIDITY',
      attemptedCandidates: 0,
    })
    expect(f.simulate).not.toHaveBeenCalled()
  })
  it('does not subtract inactive NFT liquidity from the remaining pool', async () => {
    const f = lpFixture({ lower: -300, upper: -100 })
    f.poolValues.set('liquidity', L)
    expect((await f.run()).act).toBe(true)
  })
  it('never promotes an inner-call/pre-removal quote or a forged quote object to an executable plan', async () => {
    const f = lpFixture(),
      input = { ...(await f.proofs()), policy: LP_TEST_POLICY, nowSeconds: NOW }
    const fake = vi.fn(
      async () =>
        ({
          status: 'simulated',
          path: 'manager-delegation',
          gasUnits: 1n,
          gasPriceWei: 1n,
        }) as unknown as StrategySimulationQuote,
    )
    expect(await decideLP(input, fake)).toMatchObject({
      act: false,
      code: 'INVALID_SIMULATION',
      attemptedCandidates: 1,
    })
  })
  it('rejects a real full-manager quote for a different operation', async () => {
    const f = lpFixture(),
      input = { ...(await f.proofs()), policy: LP_TEST_POLICY, nowSeconds: NOW }
    const wrong: LPAtomicSimulator = (op, snapshot) =>
      f.simulate({ ...op, minLiquidity: op.minLiquidity + 1n }, snapshot)
    expect(await decideLP(input, wrong)).toMatchObject({
      act: false,
      code: 'INVALID_SIMULATION',
      attemptedCandidates: 1,
    })
  })
  it('rejects every failed full atomic call without using candidate estimates as success', async () => {
    const f = lpFixture()
    f.simulationReader.call.mockRejectedValue(new Error('private rpc detail'))
    const result = await f.run({ ...LP_TEST_POLICY, maxSimulations: 2 })
    expect(result).toMatchObject({
      act: false,
      code: 'NO_ATOMIC_CANDIDATE',
      attemptedCandidates: 2,
    })
    expect(f.simulationReader.call).toHaveBeenCalledTimes(2)
    expect(f.simulationReader.estimateGas).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('applies the buffered gas budget and caps attempted manager simulations', async () => {
    const f = lpFixture(),
      result = await f.run({ ...LP_TEST_POLICY, maxGasCostWei: 1n, maxSimulations: 2 })
    expect(result).toMatchObject({ act: false, code: 'GAS_BUDGET', attemptedCandidates: 2 })
    expect(f.simulate).toHaveBeenCalledTimes(2)
  })
  it('times out a stuck simulator and never starts another candidate', async () => {
    const f = lpFixture(),
      input = {
        ...(await f.proofs()),
        policy: { ...LP_TEST_POLICY, simulationTimeoutMs: 1 },
        nowSeconds: NOW,
      }
    const stuck = vi.fn(() => new Promise<never>(() => {}))
    expect(await decideLP(input, stuck)).toMatchObject({
      act: false,
      code: 'SIMULATION_TIMEOUT',
      attemptedCandidates: 1,
    })
    expect(stuck).toHaveBeenCalledTimes(1)
  })
  it('does not reinterpret an expired simulation result as executable', async () => {
    const f = lpFixture(),
      input = { ...(await f.proofs()), policy: LP_TEST_POLICY, nowSeconds: NOW }
    let elapsed = 0
    const time = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    try {
      const slow: LPAtomicSimulator = async (operation, snapshot) => {
        const quote = await f.simulate(operation, snapshot)
        elapsed = 31_000
        return quote
      }
      expect(await decideLP(input, slow)).toMatchObject({
        act: false,
        code: 'DEADLINE_TOO_CLOSE',
        attemptedCandidates: 1,
      })
    } finally {
      time.mockRestore()
    }
  })
  it('copies planner policy before awaiting simulations', async () => {
    const f = lpFixture(),
      policy = { ...LP_TEST_POLICY },
      input = { ...(await f.proofs()), policy, nowSeconds: NOW }
    const original = f.simulate.getMockImplementation()
    if (!original) throw new Error('Expected simulation')
    f.simulate.mockImplementation(async (...args) => {
      policy.maxGasCostWei = 0n
      return original(...args)
    })
    expect((await decideLP(input, f.simulate)).act).toBe(true)
  })
  it('does not invent an LP after owner recovery or absent funding', async () => {
    const f = lpFixture()
    for (const field of ['currentTokenId', 'positionLiquidity', 'idle0', 'idle1'])
      f.base.setVault(field, 0n)
    expect(await f.run()).toMatchObject({ act: false, code: 'NO_POSITION', attemptedCandidates: 0 })
  })
  it('computes centered integer ranges without floating-point token pricing', () => {
    for (const tick of [-887000, -105, -1, 0, 1, 105, 887000]) {
      const ranges = lpRanges(tick, tick, 200, 10, 20)
      expect(ranges.length).toBeGreaterThan(0)
      expect(ranges.length).toBeLessThanOrEqual(3)
      for (const r of ranges) {
        expect(r.tickUpper - r.tickLower).toBe(200)
        expect(r.tickLower % 10 === 0).toBe(true)
        expect(r.tickUpper % 10 === 0).toBe(true)
        expect(Math.abs(r.tickLower + r.tickUpper - tick * 2)).toBeLessThanOrEqual(40)
      }
    }
    expect(lpRanges(0, 0, 201, 10, 20)).toEqual([])
  })
})
