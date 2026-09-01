import { expect, it } from 'vitest'
import type { Observation } from '../evidence/types.js'
import { SETTLEMENT } from './pricing.js'
import { publishedAsset, publishedPrice } from './published-price.js'

const registration = (pricing: unknown, observedAt = '2026-09-01T00:00:00.000Z'): Observation => ({
  id: observedAt,
  subject: { type: 'agent', chainId: 56, registry: '0xr', agentId: 'a1' },
  predicate: 'erc8004.registration_resolution',
  value: { manifest: { name: 'Agent', ...(pricing === undefined ? {} : { pricing }) } },
  validAt: observedAt,
  observedAt,
  recordedAt: observedAt,
  source: 'test',
  method: 'test',
  evidenceClass: 'B',
  dedupeKey: observedAt,
})

it('reads the price and the asset as one fact', () => {
  const rows = [registration({ amount: '100000000000000000', asset: SETTLEMENT.symbol })]
  expect(publishedPrice('a1', rows)).toBe(100_000_000_000_000_000n)
  expect(publishedAsset('a1', rows)).toBe(SETTLEMENT.symbol)
})

it('reports no asset rather than guessing one', () => {
  /*
   * The number alone is not a price. 100000 is ten cents in a six-decimal token
   * and a millionth of a cent in an eighteen-decimal one, so an unnamed asset
   * has to read as unnamed and let the caller refuse.
   */
  expect(publishedAsset('a1', [registration({ amount: '100000' })])).toBeNull()
  expect(publishedAsset('a1', [registration(undefined)])).toBeNull()
  expect(publishedAsset('a1', [])).toBeNull()
  expect(publishedAsset('a1', [registration({ amount: '1', asset: 42 })])).toBeNull()
})

it('follows the newest registration, not the first one seen', () => {
  // Re-registering under a different asset must not leave the old one quotable.
  const rows = [
    registration({ amount: '1', asset: 'USDT' }, '2026-01-01T00:00:00.000Z'),
    registration({ amount: '2', asset: SETTLEMENT.symbol }, '2026-09-01T00:00:00.000Z'),
  ]
  expect(publishedAsset('a1', rows)).toBe(SETTLEMENT.symbol)
  expect(publishedPrice('a1', rows)).toBe(2n)
})

it('does not read one agent’s price off another agent’s registration', () => {
  const other = { ...registration({ amount: '9', asset: 'X' }) }
  other.subject = { ...other.subject, agentId: 'a2' }
  expect(publishedPrice('a1', [other])).toBeNull()
  expect(publishedAsset('a1', [other])).toBeNull()
})
