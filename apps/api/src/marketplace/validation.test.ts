import { describe, expect, it } from 'vitest'
import { normalizeOffer, normalizeProvider, requireIdempotencyKey } from './validation.js'

const offer = {
  title: 'Read a contract',
  summary: 'Read the source and return the owner with evidence.',
  capabilityTags: ['Contract:Read', 'contract:read'],
  pricingModel: 'FIXED',
  settlementChainId: 56,
  settlementToken: `0x${'AB'.repeat(20)}`,
  settlementDecimals: 18,
  amount: '1000000000000000000',
  deliverySlaSeconds: 3600,
  reviewSlaSeconds: 3600,
  dispatchMethod: 'HTTP',
  dispatchEndpoint: 'https://agent.example/work#ignored',
}

describe('marketplace input normalization', () => {
  it('normalizes a provider once before hashing or persistence', () => {
    expect(
      normalizeProvider({
        displayName: '  Ada  ',
        summary: '  Smart contract reviewer. ',
        supportedProtocols: ['ERC-8183', 'erc-8183'],
      }),
    ).toEqual({
      displayName: 'Ada',
      summary: 'Smart contract reviewer.',
      availability: 'AVAILABLE',
      capacity: 1,
      supportedProtocols: ['erc-8183'],
      geography: {},
    })
  })

  it('keeps token amounts as canonical strings', () => {
    const normalized = normalizeOffer(offer, 250)
    expect(normalized.amount).toBe('1000000000000000000')
    expect(normalized.settlementToken).toBe(`0x${'ab'.repeat(20)}`)
    expect(normalized.capabilityTags).toEqual(['contract:read'])
    expect(normalized.dispatchEndpoint).toBe('https://agent.example/work')
  })

  it('refuses scientific notation and quote prices', () => {
    expect(() => normalizeOffer({ ...offer, amount: '1e18' }, 250)).toThrow('unsigned decimal')
    expect(() => normalizeOffer({ ...offer, pricingModel: 'QUOTE' }, 250)).toThrow(
      'must be omitted',
    )
  })

  it('does not let a provider choose AiKi fee policy', () => {
    expect(() => normalizeOffer({ ...offer, platformFeeBps: 0 }, 250)).toThrow(
      'platformFeeBps is not a supported field',
    )
    expect(normalizeOffer(offer, 175).platformFeeBps).toBe(175)
  })

  it('requires a bounded printable idempotency key', () => {
    expect(requireIdempotencyKey('manual:offer:123')).toBe('manual:offer:123')
    expect(() => requireIdempotencyKey('')).toThrow('Idempotency-Key')
    expect(() => requireIdempotencyKey('line\nbreak')).toThrow('Idempotency-Key')
  })
})
