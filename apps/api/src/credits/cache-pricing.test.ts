import { expect, it } from 'vitest'
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  explainCost,
  MARGIN,
  POINTS_PER_USD,
  pointsFor,
  rateFor,
} from './pricing.js'

/**
 * What a cached token costs.
 *
 * This is billing, so the arithmetic is asserted against the rate card rather
 * than against a number somebody typed. A cached read is a tenth of the input
 * price and writing the cache is a quarter more than reading fresh: getting
 * either wrong overcharges a person by up to ten to one for text the provider
 * never re-read.
 */

const MODEL = 'claude-sonnet-5'
const points = (usd: number) => Math.ceil(usd * POINTS_PER_USD * MARGIN)

it('prices every kind of token at its own rate', () => {
  const rate = rateFor(MODEL)
  const usage = {
    inputTokens: 10_000,
    outputTokens: 1_000,
    cacheWriteTokens: 9_000,
    cacheReadTokens: 40_000,
  }
  const expected = points(
    (10_000 * rate.inputPerMTok +
      9_000 * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER +
      40_000 * rate.inputPerMTok * CACHE_READ_MULTIPLIER +
      1_000 * rate.outputPerMTok) /
      1_000_000,
  )
  expect(pointsFor(MODEL, usage)).toBe(expected)
})

it('charges a turn that used no cache exactly what it charged before', () => {
  // Every turn recorded before caching existed has no cache fields at all, and
  // must not be repriced by their absence.
  const before = pointsFor(MODEL, { inputTokens: 52_442, outputTokens: 1_882 })
  const after = pointsFor(MODEL, {
    inputTokens: 52_442,
    outputTokens: 1_882,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  })
  expect(after).toBe(before)
  expect(before).toBe(2_413)
})

it('is much cheaper to re-read a prompt than to resend it', () => {
  /*
   * The measured turn: 52,442 input tokens across four rounds, of which about
   * 9,700 were the same instructions and tool schemas each time. Reading those
   * from cache instead of sending them is the whole point of this change.
   */
  const resent = pointsFor(MODEL, { inputTokens: 52_442, outputTokens: 1_882 })
  const cached = pointsFor(MODEL, {
    inputTokens: 52_442 - 9_700 * 4,
    cacheWriteTokens: 9_700,
    cacheReadTokens: 9_700 * 3,
    outputTokens: 1_882,
  })
  expect(cached).toBeLessThan(resent)
  // Worth stating the size: this is what decides whether a hire fits in a turn.
  expect(cached / resent).toBeLessThan(0.65)
})

it('says in words that a cached read was cheaper, and only when there was one', () => {
  const withCache = explainCost(MODEL, {
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 9_000,
  })
  expect(withCache).toMatch(/9000 read from cache at a tenth of the input price/)
  const without = explainCost(MODEL, { inputTokens: 100, outputTokens: 10 })
  expect(without).not.toMatch(/cache/)
})
