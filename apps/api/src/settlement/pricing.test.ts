import { expect, it } from 'vitest'
import { buildQuote, PLATFORM_FEE_BPS, priceJob } from './pricing.js'

it('splits a price into a fee and a total that add up exactly', () => {
  const priced = priceJob(10_000n)
  expect(priced.platformFee).toBe(250n)
  expect(priced.total).toBe(10_250n)
  expect(priced.price + priced.platformFee).toBe(priced.total)
})

it('rounds the fee down, so the platform absorbs the remainder', () => {
  // 1 wei at 2.5% is 0.025 of a unit. Rounding up would charge a unit that was
  // never quoted, which is the wrong party to inconvenience.
  expect(priceJob(1n).platformFee).toBe(0n)
  expect(priceJob(39n).platformFee).toBe(0n)
  expect(priceJob(40n).platformFee).toBe(1n)
})

it('survives amounts that would destroy a float', () => {
  const huge = 10n ** 30n
  const priced = priceJob(huge)
  expect(priced.total).toBe(huge + huge / 40n)
  expect(priced.price + priced.platformFee).toBe(priced.total)
})

it('refuses nonsense rather than quoting it', () => {
  expect(() => priceJob(-1n)).toThrow()
  expect(() => priceJob(10n, 10_001)).toThrow()
})

it('states the total and the asset on the quote itself', () => {
  const quote = buildQuote({
    quoteId: 'q1',
    agentId: '7',
    price: 2n * 10n ** 18n,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  })
  expect(quote.total.amount).toBe((2n * 10n ** 18n + 5n * 10n ** 16n).toString())
  expect(quote.feeBasisPoints).toBe(PLATFORM_FEE_BPS)
  // USDT on BNB Chain is 18 decimals. Assuming 6 is a 10^12 error in the price.
  expect(quote.settlementAsset.decimals).toBe(18)
  expect(quote.expiresAt).toBe('2026-01-01T00:05:00.000Z')
  // Gas is the relayer's, in BNB, and never leaves the mandate.
  expect(quote.estimatedGas).toBeNull()
})

it('reads a published price and refuses to invent one', async () => {
  const { publishedPrice } = await import('./published-price.js')
  const base = {
    id: 'o1',
    subject: { type: 'agent' as const, chainId: 56, registry: '0x8004', agentId: '7' },
    predicate: 'erc8004.registration_resolution',
    validAt: '2026-01-01T00:00:00Z',
    observedAt: '2026-01-01T00:00:00Z',
    recordedAt: '2026-01-01T00:00:00Z',
    source: 'test',
    method: 'test',
    evidenceClass: 'B' as const,
    dedupeKey: 'o1',
  }
  expect(
    publishedPrice('7', [{ ...base, value: { manifest: { pricing: { amount: '2000' } } } }]),
  ).toBe(2000n)
  // No manifest, no pricing block, and a nonsense amount are all "we do not
  // know", which is not the same as free.
  expect(publishedPrice('7', [{ ...base, value: {} }])).toBeNull()
  expect(publishedPrice('7', [{ ...base, value: { manifest: {} } }])).toBeNull()
  expect(
    publishedPrice('7', [{ ...base, value: { manifest: { pricing: { amount: 'lots' } } } }]),
  ).toBeNull()
  expect(publishedPrice('7', [])).toBeNull()
})
