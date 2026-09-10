import { describe, expect, it } from 'vitest'
import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  mulDiv,
  mulDivRoundingUp,
  quoteAtTick,
  sqrtRatioAtTick,
} from './math.js'

const token0 = '0x0000000000000000000000000000000000000001'
const token1 = '0x0000000000000000000000000000000000000002'
describe('Pancake exact bigint arithmetic', () => {
  it.each([
    [MIN_TICK, MIN_SQRT_RATIO],
    [-1, 79224201403219477170569942574n],
    [0, 1n << 96n],
    [1, 79232123823359799118286999568n],
    [MAX_TICK, MAX_SQRT_RATIO],
  ] as const)('matches canonical tick %i', (tick, ratio) =>
    expect(sqrtRatioAtTick(tick)).toBe(ratio),
  )
  it('retains full 512-bit intermediate precision with checked uint256 results', () => {
    const max = (1n << 256n) - 1n
    expect(mulDiv(max, max, max)).toBe(max)
    expect(mulDiv(10n, 10n, 6n)).toBe(16n)
    expect(mulDivRoundingUp(10n, 10n, 6n)).toBe(17n)
    expect(() => mulDiv(max, max, 1n)).toThrow()
    expect(() => mulDiv(1n, 1n, 0n)).toThrow()
    expect(() => mulDiv(-1n, 1n, 1n)).toThrow()
    expect(() => mulDiv(max + 1n, 1n, max)).toThrow()
    expect(() => mulDivRoundingUp(max - 1n, max - 1n, max - 2n)).toThrow()
  })
  it('quotes both directions at parity and monotonic across both ratio branches', () => {
    const amount = 10n ** 18n
    expect(quoteAtTick(0, amount, token0, token1)).toBe(amount)
    expect(quoteAtTick(0, amount, token1, token0)).toBe(amount)
    expect(quoteAtTick(1, amount, token0, token1)).toBe(1000100000000000000n)
    expect(quoteAtTick(-1, amount, token1, token0)).toBe(1000099999999999999n)
    for (const tick of [-887272, -500000, 500000, 887272]) {
      const forward = quoteAtTick(tick, amount, token0, token1)
      const reverse = quoteAtTick(tick, amount, token1, token0)
      expect(forward * reverse).toBeLessThanOrEqual(amount * amount)
    }
  })
  it('rejects malformed ticks, pairs and oversized quote inputs', () => {
    for (const tick of [MIN_TICK - 1, MAX_TICK + 1, NaN, 1.5])
      expect(() => sqrtRatioAtTick(tick)).toThrow()
    expect(() => quoteAtTick(0, 1n << 128n, token0, token1)).toThrow()
    expect(() => quoteAtTick(0, 1n, token0, token0)).toThrow()
  })
})
