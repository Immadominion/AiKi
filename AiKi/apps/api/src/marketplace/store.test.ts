import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { BSC_MAINNET } from '../config/chains.js'
import { hashCanonicalJson } from './canonical-json.js'
import type { ActorIdentity, CreateOffer, JsonValue, PutProvider } from './model.js'
import { buildJobPreview } from './preview.js'
import { PostgresMarketplaceSettlementWorker } from './settlement-worker.js'
import { PostgresMarketplaceStore } from './store.js'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgresMarketplaceStore', () => {
  const store = new PostgresMarketplaceStore(databaseUrl as string)
  const worker = new PostgresMarketplaceSettlementWorker(databaseUrl as string)
  const sql = postgres(databaseUrl as string, { max: 1 })
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
    settlementToken: BSC_MAINNET.contracts.settlementToken.toLowerCase() as `0x${string}`,
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

  afterAll(async () => {
    await Promise.all([store.close(), worker.close(), sql.end()])
  })

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

  it('creates an unfunded agreement and funding operation transactionally', async () => {
    await store.putProvider(actor, provider, {
      key: 'postgres-provider-job',
      requestHash: hash(provider),
    })
    const published = await store.createOffer(
      actor,
      { ...offer, title: 'Fundable agreement' },
      {
        key: 'postgres-offer-job',
        requestHash: hash({ ...offer, title: 'Fundable agreement' }),
      },
    )
    const currentOffer = await store.getOffer(published.body.id)
    if (!currentOffer) throw new Error('Offer disappeared before job creation.')
    const input = {
      offerId: currentOffer.id,
      offerVersion: currentOffer.version,
      brief: 'Check the ownership and upgrade controls.',
      requirements: { contract: `0x${'12'.repeat(20)}` },
      definitionOfDone: 'Return every finding with a source reference.',
      evidenceRequirements: { sourceLines: true },
    }
    const preview = buildJobPreview(currentOffer, input)
    const created = await store.createJob(
      stranger,
      { ...input, previewHash: preview.previewHash },
      {
        key: 'postgres-job-create',
        requestHash: hash({ ...input, previewHash: preview.previewHash }),
      },
    )
    expect(created.statusCode).toBe(201)
    expect(created.body.settlementState).toBe('UNFUNDED')
    expect(created.body.fundingOperation.status).toBe('REQUESTED')
    expect(created.body.settlement.totalAmount).toBe(preview.settlement.quote?.totalAmount)

    const rows = await sql<
      {
        agreements: string
        operations: string
        outbox: string
      }[]
    >`
      SELECT
        (SELECT count(*) FROM job_agreements WHERE job_id = ${created.body.id}) AS agreements,
        (SELECT count(*) FROM settlement_operations WHERE job_id = ${created.body.id}
          AND status = 'REQUESTED' AND operation_type = 'CREATE_ESCROW') AS operations,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id = ${created.body.id}
          AND topic = 'marketplace.settlement.create.requested') AS outbox
    `
    expect(rows[0]).toEqual({ agreements: '1', operations: '1', outbox: '1' })

    const prepared = await worker.prepareNext('store-test')
    expect(prepared?.jobId).toBe(created.body.id)
    expect(prepared?.transaction.data.startsWith('0x41528812')).toBe(true)
    expect(prepared?.transaction.to).toBe(created.body.settlement.contract)

    const preparedRows = await sql<
      {
        status: string
        prepared: boolean
        outbox_status: string
      }[]
    >`
      SELECT
        so.status,
        so.prepared_transaction IS NOT NULL AS prepared,
        o.status AS outbox_status
      FROM settlement_operations so
      JOIN outbox_events o ON o.payload ->> 'operationId' = so.id::text
      WHERE so.id = ${created.body.fundingOperation.id}
    `
    expect(preparedRows[0]).toEqual({
      status: 'PREPARED',
      prepared: true,
      outbox_status: 'DELIVERED',
    })
  })
})
