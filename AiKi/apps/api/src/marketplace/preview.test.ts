import { describe, expect, it } from 'vitest'
import type { OfferView } from './model.js'
import { buildJobPreview, normalizePreviewJob } from './preview.js'

const offer: OfferView = {
  id: '26f30755-c892-4a18-8d70-09321038b053',
  providerId: '494a4d61-0414-45fc-958f-92c3982c34c5',
  providerName: 'Ada',
  status: 'ACTIVE',
  visibility: 'PUBLIC',
  version: 3,
  title: 'Review one contract',
  summary: 'Evidence included.',
  capabilityTags: ['contract:review'],
  inputSchema: {},
  outputSchema: {},
  evidenceSchema: {},
  pricing: {
    model: 'FIXED',
    chainId: 56,
    token: `0x${'ab'.repeat(20)}`,
    decimals: 18,
    amount: '1000000000000000001',
    platformFeeBps: 250,
  },
  deliverySlaSeconds: 3600,
  reviewSlaSeconds: 7200,
  includedRevisions: 1,
  concurrentCapacity: 2,
  dispatch: { method: 'MANUAL', endpoint: null },
  failoverSafe: false,
  termsHash: '1'.repeat(64),
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
}

describe('job preview', () => {
  const input = normalizePreviewJob({
    offerId: offer.id,
    offerVersion: 3,
    brief: 'Check the ownership and upgrade controls.',
    requirements: { contract: '0x1234' },
    definitionOfDone: 'Return the owner and its supporting call.',
    evidenceRequirements: { transaction: true },
  })

  it('binds scope, immutable offer terms, and exact money into one hash', () => {
    const preview = buildJobPreview(offer, input)
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.settlement.quote).toEqual({
      providerAmount: '1000000000000000001',
      platformFeeAmount: '25000000000000001',
      totalAmount: '1025000000000000002',
    })
    expect(preview.nextAction).toBe('CREATE_JOB')
  })

  it('changes the hash when the definition of done changes', () => {
    const first = buildJobPreview(offer, input)
    const second = buildJobPreview(offer, { ...input, definitionOfDone: 'Return a full report.' })
    expect(first.previewHash).not.toBe(second.previewHash)
  })

  it('makes quote-priced work non-hireable until terms are negotiated', () => {
    const preview = buildJobPreview(
      { ...offer, pricing: { ...offer.pricing, model: 'QUOTE', amount: null } },
      input,
    )
    expect(preview.canCreateJob).toBe(false)
    expect(preview.nextAction).toBe('REQUEST_QUOTE')
  })

  it('refuses a stale offer version instead of repricing silently', () => {
    expect(() => buildJobPreview(offer, { ...input, offerVersion: 2 })).toThrow(
      'Review its current terms',
    )
  })
})
