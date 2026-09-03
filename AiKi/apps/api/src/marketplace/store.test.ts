import { afterAll, describe, expect, it } from 'vitest'
import { hashCanonicalJson } from './canonical-json.js'
import type { ActorIdentity, CreateOffer, JsonValue, PutProvider } from './model.js'
import { PostgresMarketplaceStore } from './store.js'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgresMarketplaceStore', () => {
  const store = new PostgresMarketplaceStore(databaseUrl as string)
  const actor: ActorIdentity = { chainId: 56, address: `0x${'61'.repeat(20)}` }
  const stranger: ActorIdentity = { chainId: 56, address: `0x${'72'.repeat(20)}` }
  const provider: PutProvider = {
    displayName: 'Kernel verifier',
    summary: 'Exercises the real transactional marketplace store.',
    availability: 'AVAILABLE',
    capacity: 2,
    supportedProtocols: ['erc-8183'],
    geography: {},
  }
  const offer: CreateOffer = {
    title: 'Verify one contract',
    summary: 'Return each ownership finding with evidence.',
    capabilityTags: ['contract:verify'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    evidenceSchema: { type: 'object' },
    pricingModel: 'FIXED',
    settlementChainId: 56,
    settlementToken: `0x${'83'.repeat(20)}`,
    settlementDecimals: 18,
    amount: '1000000000000000001',
    platformFeeBps: 250,
    deliverySlaSeconds: 3600,
    reviewSlaSeconds: 7200,
    includedRevisions: 1,
    concurrentCapacity: 2,
    dispatchMethod: 'MANUAL',
    dispatchEndpoint: null,
    failoverSafe: false,
  }

  const hash = (value: unknown) => hashCanonicalJson(value as JsonValue)

  afterAll(async () => store.close())

  it('atomically publishes a provider and immutable offer version', async () => {
    const profile = await store.putProvider(actor, provider, {
      key: 'postgres-provider-1',
      requestHash: hash(provider),
    })
    expect(profile.body.profileVersion).toBe('1')

    const published = await store.createOffer(actor, offer, {
      key: 'postgres-offer-1',
      requestHash: hash(offer),
    })
    expect(published.statusCode).toBe(201)
    expect(published.body.pricing.amount).toBe('1000000000000000001')
    expect((await store.getOffer(published.body.id))?.termsHash).toBe(published.body.termsHash)
  })

  it('serializes concurrent retries into one command result', async () => {
    const idempotency = { key: 'postgres-provider-race', requestHash: hash(provider) }
    const [left, right] = await Promise.all([
      store.putProvider(actor, provider, idempotency),
      store.putProvider(actor, provider, idempotency),
    ])
    expect([left.replayed, right.replayed].sort()).toEqual([false, true])
    expect(left.body).toEqual(right.body)
  })

  it('rejects conflicting input and another actor pausing the offer', async () => {
    await store.putProvider(stranger, provider, {
      key: 'postgres-stranger-profile',
      requestHash: hash(provider),
    })
    const conflictKey = 'postgres-provider-conflict'
    await store.putProvider(actor, provider, {
      key: conflictKey,
      requestHash: hash(provider),
    })
    await expect(
      store.putProvider(
        actor,
        { ...provider, displayName: 'Different' },
        {
          key: conflictKey,
          requestHash: hash({ ...provider, displayName: 'Different' }),
        },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const published = await store.createOffer(
      actor,
      { ...offer, title: 'Owner-only pause' },
      {
        key: 'postgres-offer-owner-check',
        requestHash: hash({ ...offer, title: 'Owner-only pause' }),
      },
    )
    await expect(
      store.pauseOffer(stranger, published.body.id, {
        key: 'postgres-not-owner',
        requestHash: hash({ offerId: published.body.id }),
      }),
    ).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' })
  })
})
