import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { BSC_MAINNET } from '../config/chains.js'
import { createApiServer } from '../http/server.js'
import { InMemoryMarketplaceStore } from './memory-store.js'

const signer = new SessionSigner('marketplace-route-test-secret-long-enough')
const OWNER = `0x${'ab'.repeat(20)}`
const OTHER = `0x${'cd'.repeat(20)}`
const cookie = (address = OWNER) => ({
  cookie: `aiki_session=${signer.issue(address, 56)}`,
})
const auth = () => ({
  signer,
  nonces: new InMemoryNonceStore(),
  domain: 'aiki.test',
  secureCookies: false,
  client: createPublicClient({ chain: bsc, transport: http('http://127.0.0.1:1') }),
})
const profile = {
  displayName: 'Ada',
  summary: 'Reads smart contracts and returns cited findings.',
  capacity: 2,
  supportedProtocols: ['erc-8183'],
}
const offer = {
  title: 'Review one contract',
  summary: 'Read the supplied contract and return evidence for each finding.',
  capabilityTags: ['contract:review'],
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  evidenceSchema: { type: 'object' },
  pricingModel: 'FIXED',
  settlementChainId: 56,
  settlementToken: `0x${'ef'.repeat(20)}`,
  settlementDecimals: 18,
  amount: '1000000000000000001',
  deliverySlaSeconds: 3600,
  reviewSlaSeconds: 3600,
  includedRevisions: 1,
  dispatchMethod: 'MANUAL',
}
const supportedOffer = {
  ...offer,
  settlementToken: BSC_MAINNET.contracts.settlementToken.toLowerCase(),
}

const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const server = () => {
  const app = createApiServer({
    observations: () => [],
    auth: auth(),
    marketplace: new InMemoryMarketplaceStore(),
  })
  apps.push(app)
  return app
}

describe('canonical marketplace routes', () => {
  it('requires both authentication and caller-owned idempotency', async () => {
    const app = server()
    expect(
      (await app.inject({ method: 'PUT', url: '/v2/providers/me', payload: profile })).statusCode,
    ).toBe(401)
    const missingKey = await app.inject({
      method: 'PUT',
      url: '/v2/providers/me',
      headers: cookie(),
      payload: profile,
    })
    expect(missingKey.statusCode).toBe(400)
    expect(missingKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('replays the exact response and rejects reuse for another request', async () => {
    const app = server()
    const request = {
      method: 'PUT' as const,
      url: '/v2/providers/me',
      headers: { ...cookie(), 'idempotency-key': 'provider-profile-1' },
      payload: profile,
    }
    const first = await app.inject(request)
    const replay = await app.inject({
      ...request,
      payload: { ...profile, displayName: '  Ada  ' },
    })
    expect(first.statusCode).toBe(200)
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json()).toEqual(first.json())

    const conflict = await app.inject({
      ...request,
      payload: { ...profile, displayName: 'Grace' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('publishes an exact-value offer and removes it from discovery when paused', async () => {
    const app = server()
    await app.inject({
      method: 'PUT',
      url: '/v2/providers/me',
      headers: { ...cookie(), 'idempotency-key': 'provider-before-offer' },
      payload: profile,
    })
    const published = await app.inject({
      method: 'POST',
      url: '/v2/offers',
      headers: { ...cookie(), 'idempotency-key': 'offer-1' },
      payload: offer,
    })
    expect(published.statusCode).toBe(201)
    expect(published.json().pricing.amount).toBe('1000000000000000001')
    expect(published.json().termsHash).toMatch(/^[0-9a-f]{64}$/)

    const offerId = published.json().id as string
    expect((await app.inject('/v2/offers')).json().items).toHaveLength(1)
    expect((await app.inject(`/v2/offers/${offerId}`)).statusCode).toBe(200)
    const preview = await app.inject({
      method: 'POST',
      url: '/v2/jobs/preview',
      payload: {
        offerId,
        offerVersion: 1,
        brief: 'Check the ownership and upgrade controls.',
        requirements: { contract: `0x${'12'.repeat(20)}` },
        definitionOfDone: 'Return every finding with a source reference.',
        evidenceRequirements: { sourceLines: true },
      },
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().settlement.quote.totalAmount).toBe('1025000000000000002')

    const stranger = await app.inject({
      method: 'POST',
      url: `/v2/offers/${offerId}/pause`,
      headers: { ...cookie(OTHER), 'idempotency-key': 'not-mine' },
    })
    expect(stranger.statusCode).toBe(404)

    const paused = await app.inject({
      method: 'POST',
      url: `/v2/offers/${offerId}/pause`,
      headers: { ...cookie(), 'idempotency-key': 'pause-1' },
    })
    expect(paused.statusCode).toBe(200)
    expect(paused.json().status).toBe('PAUSED')
    expect((await app.inject('/v2/offers')).json().items).toHaveLength(0)
    expect((await app.inject(`/v2/offers/${offerId}`)).statusCode).toBe(404)
  })

  it('does not publish an offer before the seller has a provider profile', async () => {
    const app = server()
    const response = await app.inject({
      method: 'POST',
      url: '/v2/offers',
      headers: { ...cookie(), 'idempotency-key': 'offer-without-provider' },
      payload: offer,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('PROVIDER_PROFILE_REQUIRED')
  })

  it('rejects non-canonical money and malformed page cursors as caller errors', async () => {
    const app = server()
    const invalidAmount = await app.inject({
      method: 'POST',
      url: '/v2/offers',
      headers: { ...cookie(), 'idempotency-key': 'bad-amount' },
      payload: { ...offer, amount: '1e18' },
    })
    expect(invalidAmount.statusCode).toBe(400)
    expect(invalidAmount.json().error.code).toBe('INVALID_MARKETPLACE_INPUT')

    const cursor = await app.inject('/v2/offers?cursor=not-a-cursor')
    expect(cursor.statusCode).toBe(400)
    expect(cursor.json().error.code).toBe('INVALID_CURSOR')
  })

  it('creates an unfunded job from the exact preview terms', async () => {
    const app = server()
    await app.inject({
      method: 'PUT',
      url: '/v2/providers/me',
      headers: { ...cookie(), 'idempotency-key': 'provider-for-job' },
      payload: profile,
    })
    const published = await app.inject({
      method: 'POST',
      url: '/v2/offers',
      headers: { ...cookie(), 'idempotency-key': 'offer-for-job' },
      payload: supportedOffer,
    })
    expect(published.statusCode).toBe(201)
    const offerId = published.json().id as string
    const jobInput = {
      offerId,
      offerVersion: 1,
      brief: 'Check the ownership and upgrade controls.',
      requirements: { contract: `0x${'12'.repeat(20)}` },
      definitionOfDone: 'Return every finding with a source reference.',
      evidenceRequirements: { sourceLines: true },
    }
    const preview = await app.inject({
      method: 'POST',
      url: '/v2/jobs/preview',
      payload: jobInput,
    })
    expect(preview.statusCode).toBe(200)

    const created = await app.inject({
      method: 'POST',
      url: '/v2/jobs',
      headers: { ...cookie(OTHER), 'idempotency-key': 'create-job-1' },
      payload: { ...jobInput, previewHash: preview.json().previewHash },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().workState).toBe('ASSIGNED')
    expect(created.json().settlementState).toBe('UNFUNDED')
    expect(created.json().fundingOperation.status).toBe('REQUESTED')
    expect(created.json().fundingOperation.operationType).toBe('CREATE_ESCROW')
    expect(created.json().nextAction).toBe('CREATE_ESCROW')
    expect(created.json().settlement.contract).toBe(
      BSC_MAINNET.contracts.erc8183Commerce.toLowerCase(),
    )

    const replay = await app.inject({
      method: 'POST',
      url: '/v2/jobs',
      headers: { ...cookie(OTHER), 'idempotency-key': 'create-job-1' },
      payload: { ...jobInput, previewHash: preview.json().previewHash },
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json()).toEqual(created.json())

    const wrongActorStart = await app.inject({
      method: 'POST',
      url: `/v2/jobs/${created.json().id}/start`,
      headers: { ...cookie(OTHER), 'idempotency-key': 'wrong-provider-start' },
    })
    expect(wrongActorStart.statusCode).toBe(404)
    expect(wrongActorStart.json().error.code).toBe('JOB_NOT_FOUND')

    const unfundedStart = await app.inject({
      method: 'POST',
      url: `/v2/jobs/${created.json().id}/start`,
      headers: { ...cookie(), 'idempotency-key': 'unfunded-start' },
    })
    expect(unfundedStart.statusCode).toBe(409)
    expect(unfundedStart.json().error.code).toBe('JOB_NOT_FUNDED')

    const unfundedSubmission = await app.inject({
      method: 'POST',
      url: `/v2/jobs/${created.json().id}/submissions`,
      headers: { ...cookie(), 'idempotency-key': 'unfunded-submission' },
      payload: {
        output: { verdict: 'done' },
        evidence: { source: 'manual' },
      },
    })
    expect(unfundedSubmission.statusCode).toBe(409)
    expect(unfundedSubmission.json().error.code).toBe('JOB_NOT_FUNDED')

    const badSubmission = await app.inject({
      method: 'POST',
      url: `/v2/jobs/${created.json().id}/submissions`,
      headers: { ...cookie(), 'idempotency-key': 'bad-submission' },
      payload: {
        output: [],
        evidence: { source: 'manual' },
      },
    })
    expect(badSubmission.statusCode).toBe(400)
    expect(badSubmission.json().error.code).toBe('INVALID_MARKETPLACE_INPUT')

    const badReview = await app.inject({
      method: 'POST',
      url: `/v2/jobs/${created.json().id}/reviews`,
      headers: { ...cookie(OTHER), 'idempotency-key': 'bad-review' },
      payload: {
        decision: 'REQUEST_CHANGES',
        note: 'Almost there.',
      },
    })
    expect(badReview.statusCode).toBe(400)
    expect(badReview.json().error.code).toBe('INVALID_MARKETPLACE_INPUT')
  })

  it('does not create a job from stale, self-hired, or unsupported funding terms', async () => {
    const app = server()
    await app.inject({
      method: 'PUT',
      url: '/v2/providers/me',
      headers: { ...cookie(), 'idempotency-key': 'provider-for-rejection' },
      payload: profile,
    })
    const published = await app.inject({
      method: 'POST',
      url: '/v2/offers',
      headers: { ...cookie(), 'idempotency-key': 'offer-for-rejection' },
      payload: supportedOffer,
    })
    const offerId = published.json().id as string
    const jobInput = {
      offerId,
      offerVersion: 1,
      brief: 'Check the ownership and upgrade controls.',
      requirements: { contract: `0x${'12'.repeat(20)}` },
      definitionOfDone: 'Return every finding with a source reference.',
      evidenceRequirements: { sourceLines: true },
    }
    const preview = await app.inject({
      method: 'POST',
      url: '/v2/jobs/preview',
      payload: jobInput,
    })
    const mismatch = await app.inject({
      method: 'POST',
      url: '/v2/jobs',
      headers: { ...cookie(OTHER), 'idempotency-key': 'bad-preview-hash' },
      payload: { ...jobInput, previewHash: '0'.repeat(64) },
    })
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json().error.code).toBe('PREVIEW_HASH_MISMATCH')

    const selfHire = await app.inject({
      method: 'POST',
      url: '/v2/jobs',
      headers: { ...cookie(), 'idempotency-key': 'self-hire' },
      payload: { ...jobInput, previewHash: preview.json().previewHash },
    })
    expect(selfHire.statusCode).toBe(409)
    expect(selfHire.json().error.code).toBe('SELF_HIRE_FORBIDDEN')

    const unsupported = await app.inject({
      method: 'POST',
      url: '/v2/offers',
      headers: { ...cookie(), 'idempotency-key': 'unsupported-offer' },
      payload: { ...offer, title: 'Unsupported token offer' },
    })
    const unsupportedInput = { ...jobInput, offerId: unsupported.json().id as string }
    const unsupportedPreview = await app.inject({
      method: 'POST',
      url: '/v2/jobs/preview',
      payload: unsupportedInput,
    })
    const unsupportedCreate = await app.inject({
      method: 'POST',
      url: '/v2/jobs',
      headers: { ...cookie(OTHER), 'idempotency-key': 'unsupported-create' },
      payload: { ...unsupportedInput, previewHash: unsupportedPreview.json().previewHash },
    })
    expect(unsupportedCreate.statusCode).toBe(409)
    expect(unsupportedCreate.json().error.code).toBe('SETTLEMENT_RAIL_UNSUPPORTED')
  })
})
