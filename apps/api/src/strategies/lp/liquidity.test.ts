import { describe, expect, it } from 'vitest'
import { MAX_TICK, MIN_TICK, sqrtRatioAtTick } from '../grid/math.js'
import { amountsForLiquidity, liquidityForAmounts, MAX_UINT128 } from './liquidity.js'

describe('LP canonical fixed-point liquidity arithmetic', () => {
  it('matches exact Pancake asymmetric amount0 intermediate floors', () => {
    const sqrt = 1n << 96n,
      a = sqrt / 2n,
      b = sqrt * 2n
    expect(amountsForLiquidity(sqrt, a, b, 1000n)).toEqual([500n, 500n])
    expect(liquidityForAmounts(sqrt, a, b, 500n, 500n)).toBe(1000n)
    expect(amountsForLiquidity(sqrt, b, a, 1001n)).toEqual([500n, 500n])
    expect(amountsForLiquidity(a, a, b, 1000n)).toEqual([1500n, 0n])
    expect(amountsForLiquidity(b, a, b, 1000n)).toEqual([0n, 1500n])
    expect(liquidityForAmounts(a, a, b, 1500n, 0n)).toBe(1000n)
    expect(liquidityForAmounts(b, a, b, 0n, 1500n)).toBe(1000n)
  })
  it('never values a floored round trip above its original inventory', () => {
    for (const tick of [-100000, -1000, -1, 0, 1, 1000, 100000]) {
      const sqrt = sqrtRatioAtTick(tick),
        a = sqrtRatioAtTick(tick - 100),
        b = sqrtRatioAtTick(tick + 100)
      for (const l of [1n, 1_000_000n, 10n ** 24n]) {
        const amounts = amountsForLiquidity(sqrt, a, b, l)
        const rebuilt = liquidityForAmounts(sqrt, a, b, ...amounts)
        expect(rebuilt).toBeLessThanOrEqual(l)
        const recovered = amountsForLiquidity(sqrt, a, b, rebuilt)
        expect(recovered[0]).toBeLessThanOrEqual(amounts[0])
        expect(recovered[1]).toBeLessThanOrEqual(amounts[1])
      }
    }
  })
  it('rejects zero denominators, out-of-domain prices and uint128 liquidity overflow', () => {
    const sqrt = 1n << 96n
    expect(() => amountsForLiquidity(sqrt, sqrt, sqrt, 1n)).toThrow()
    expect(() => amountsForLiquidity(0n, sqrt / 2n, sqrt, 1n)).toThrow()
    expect(() => amountsForLiquidity(sqrt, sqrt / 2n, sqrt * 2n, MAX_UINT128 + 1n)).toThrow()
    expect(() => liquidityForAmounts(sqrt, sqrt / 2n, sqrt * 2n, 1n << 200n, 1n << 200n)).toThrow()
    expect(
      amountsForLiquidity(
        sqrtRatioAtTick(MIN_TICK),
        sqrtRatioAtTick(MIN_TICK),
        sqrtRatioAtTick(MAX_TICK),
        1n,
      )[1],
    ).toBe(0n)
  })
})
