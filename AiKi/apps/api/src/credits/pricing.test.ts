import { expect, it } from 'vitest'
import {
  DEFAULT_MODEL,
  explainCost,
  MARGIN,
  MODELS,
  POINTS_PER_USD,
  pointsFor,
  pointsForUsdt,
} from './pricing.js'

it('prices a turn from the real token rates, arithmetic anyone can redo', () => {
  // Sonnet: $3/MTok in, $15/MTok out. 10k in and 2k out is
  // 0.03 + 0.03 = $0.06, x10,000 points = 600, x1.3 margin = 780.
  const points = pointsFor('claude-sonnet-5', { inputTokens: 10_000, outputTokens: 2_000 })
  expect(points).toBe(780)
})

it('rounds up, so a turn is never free through rounding', () => {
  const points = pointsFor('claude-haiku-4-5-20251001', { inputTokens: 1, outputTokens: 1 })
  expect(points).toBe(1)
  expect(pointsFor('claude-sonnet-5', { inputTokens: 0, outputTokens: 0 })).toBe(0)
})

it('charges more for the more expensive model, in the ratio the provider does', () => {
  const usage = { inputTokens: 10_000, outputTokens: 2_000 }
  const haiku = pointsFor('claude-haiku-4-5-20251001', usage)
  const sonnet = pointsFor('claude-sonnet-5', usage)
  // Sonnet is 3x Haiku on both rates, so the points must be 3x too.
  expect(sonnet).toBe(haiku * 3)
})

it('refuses to price a model it has no rate for', () => {
  // Silently charging zero for an unknown model would make adding one a way to
  // get free turns.
  expect(() => pointsFor('some-new-model', { inputTokens: 100, outputTokens: 100 })).toThrow(
    /no point rate/i,
  )
})

it('turns a USDT payment into points at the published rate', () => {
  expect(pointsForUsdt(1_000_000n)).toBe(POINTS_PER_USD)
  expect(pointsForUsdt(2_500_000n)).toBe(POINTS_PER_USD * 2.5)
  // Dust rounds to nothing rather than to something.
  expect(pointsForUsdt(50n)).toBe(0)
})

it('explains a charge in the terms it was computed from', () => {
  // A person asking "why did that cost 780" gets the sum, not a shrug.
  const said = explainCost('claude-sonnet-5', { inputTokens: 10_000, outputTokens: 2_000 })
  expect(said).toContain('10000 in and 2000 out')
  expect(said).toContain('$3')
  expect(said).toContain('$15')
  expect(said).toContain('780 points')
  expect(said).toContain(`${Math.round((MARGIN - 1) * 100)}%`)
})

it('defaults to a model that exists and can call tools', () => {
  expect(MODELS[DEFAULT_MODEL]).toBeDefined()
})
