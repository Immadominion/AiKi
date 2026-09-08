import postgres from 'postgres'
import { encodeAbiParameters, encodeEventTopics } from 'viem'
import { afterAll, describe, expect, it } from 'vitest'
import { BSC_MAINNET } from '../config/chains.js'
import { APEX_COMMERCE_ABI } from './apex.js'
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
    const actorProfile = await store.putProvider(actor, provider, {
      key: 'postgres-provider-job',
      requestHash: hash(provider),
    })
    const actorProfileId = actorProfile.body.id
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
    const createdJobRead = await store.getJob(stranger, created.body.id)
    expect(createdJobRead).toMatchObject({
      id: created.body.id,
      workState: 'ASSIGNED',
      settlementState: 'UNFUNDED',
      nextAction: 'CREATE_ESCROW',
    })
    expect(createdJobRead?.fundingOperation).toMatchObject({
      id: created.body.fundingOperation.id,
      status: 'REQUESTED',
      operationType: 'CREATE_ESCROW',
    })
    await expect(
      store.getJob({ chainId: 56, address: `0x${'99'.repeat(20)}` }, created.body.id),
    ).resolves.toBeNull()

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

    const submitted = await worker.submitNext({
      submit: async (transaction) => {
        expect(transaction).toEqual(prepared?.transaction)
        return {
          transactionHash: `0x${'55'.repeat(32)}`,
          transactionNonce: '7',
        }
      },
    })
    expect(submitted?.operationId).toBe(created.body.fundingOperation.id)
    expect(submitted?.transactionHash).toBe(`0x${'55'.repeat(32)}`)

    const submittedRows = await sql<
      {
        status: string
        transaction_hash: string
        transaction_nonce: string
      }[]
    >`
      SELECT status, transaction_hash, transaction_nonce
      FROM settlement_operations
      WHERE id = ${created.body.fundingOperation.id}
    `
    expect(submittedRows[0]).toEqual({
      status: 'SUBMITTED',
      transaction_hash: `0x${'55'.repeat(32)}`,
      transaction_nonce: '7',
    })

    const finalized = await worker.finalizeNext({
      finalizedReceipt: async (hash) => ({
        status: 'success',
        transactionHash: hash,
        blockNumber: 100n,
        blockHash: `0x${'66'.repeat(32)}`,
        logs: [
          {
            address: created.body.settlement.contract,
            topics: encodeEventTopics({
              abi: APEX_COMMERCE_ABI,
              eventName: 'JobCreated',
              args: {
                jobId: 123n,
                client: stranger.address,
                provider: actor.address,
              },
            }) as `0x${string}`[],
            data: encodeAbiParameters(
              [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }],
              [
                BSC_MAINNET.contracts.erc8183EvaluatorRouter.toLowerCase() as `0x${string}`,
                BigInt(Math.floor(new Date(created.body.deadlines.hardExpiry).getTime() / 1000)),
                BSC_MAINNET.contracts.erc8183EvaluatorRouter.toLowerCase() as `0x${string}`,
              ],
            ),
            transactionHash: hash,
            logIndex: 3,
            blockNumber: 100n,
            blockHash: `0x${'66'.repeat(32)}`,
          },
        ],
      }),
    })
    expect(finalized?.externalJobId).toBe('123')
    const submittedHash = submitted?.transactionHash
    if (!submittedHash) throw new Error('Submission did not return a transaction hash.')

    const finalizedRows = await sql<
      {
        create_status: string
        external_job_id: string
        chain_events: string
        fund_operations: string
        fund_outbox: string
      }[]
    >`
      SELECT
        (SELECT status FROM settlement_operations
          WHERE id = ${created.body.fundingOperation.id}) AS create_status,
        (SELECT external_job_id FROM job_agreements
          WHERE id = ${created.body.agreementId}) AS external_job_id,
        (SELECT count(*) FROM chain_events
          WHERE transaction_hash = ${submittedHash}) AS chain_events,
        (SELECT count(*) FROM settlement_operations
          WHERE job_id = ${created.body.id}
            AND operation_type = 'FUND'
            AND status = 'REQUESTED') AS fund_operations,
        (SELECT count(*) FROM outbox_events
          WHERE aggregate_id = ${created.body.id}
            AND topic = 'marketplace.settlement.fund.requested') AS fund_outbox
    `
    expect(finalizedRows[0]).toEqual({
      create_status: 'FINALIZED',
      external_job_id: '123',
      chain_events: '1',
      fund_operations: '1',
      fund_outbox: '1',
    })

    const preparedFund = await worker.prepareFundNext('store-test')
    expect(preparedFund?.jobId).toBe(created.body.id)
    expect(preparedFund?.transaction.functionName).toBe('fund')
    expect(preparedFund?.transaction.data.startsWith('0xd2e13f50')).toBe(true)
    expect(preparedFund?.transaction.to).toBe(created.body.settlement.contract)
    if (preparedFund?.transaction.functionName !== 'fund')
      throw new Error('Fund operation did not prepare APEX fund calldata.')
    expect(preparedFund.transaction.args).toEqual({
      externalJobId: '123',
      amount: created.body.settlement.totalAmount,
      optParams: '0x',
    })

    const preparedFundRows = await sql<
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
      JOIN outbox_events o ON o.dedupe_key = so.logical_key
      WHERE so.id = ${preparedFund.operationId}
    `
    expect(preparedFundRows[0]).toEqual({
      status: 'PREPARED',
      prepared: true,
      outbox_status: 'DELIVERED',
    })

    const submittedFund = await worker.submitNext({
      submit: async (transaction) => {
        expect(transaction).toEqual(preparedFund.transaction)
        return {
          transactionHash: `0x${'77'.repeat(32)}`,
          transactionNonce: '8',
        }
      },
    })
    expect(submittedFund?.operationId).toBe(preparedFund.operationId)
    expect(submittedFund?.transactionHash).toBe(`0x${'77'.repeat(32)}`)
    const submittedFundHash = submittedFund?.transactionHash
    if (!submittedFundHash) throw new Error('Fund submission did not return a transaction hash.')

    const submittedFundRows = await sql<
      {
        status: string
        transaction_hash: string
        transaction_nonce: string
        settlement_state: string
      }[]
    >`
      SELECT so.status, so.transaction_hash, so.transaction_nonce, mj.settlement_state
      FROM settlement_operations so
      JOIN marketplace_jobs mj ON mj.id = so.job_id
      WHERE so.id = ${preparedFund.operationId}
    `
    expect(submittedFundRows[0]).toEqual({
      status: 'SUBMITTED',
      transaction_hash: `0x${'77'.repeat(32)}`,
      transaction_nonce: '8',
      settlement_state: 'FUNDING_SUBMITTED',
    })

    const finalizedFund = await worker.finalizeFundNext({
      finalizedReceipt: async (hash) => ({
        status: 'success',
        transactionHash: hash,
        blockNumber: 101n,
        blockHash: `0x${'88'.repeat(32)}`,
        logs: [
          {
            address: created.body.settlement.contract,
            topics: encodeEventTopics({
              abi: APEX_COMMERCE_ABI,
              eventName: 'JobFunded',
              args: {
                jobId: 123n,
                client: stranger.address,
              },
            }) as `0x${string}`[],
            data: encodeAbiParameters(
              [{ type: 'uint256' }],
              [BigInt(created.body.settlement.totalAmount)],
            ),
            transactionHash: hash,
            logIndex: 4,
            blockNumber: 101n,
            blockHash: `0x${'88'.repeat(32)}`,
          },
        ],
      }),
    })
    expect(finalizedFund).toMatchObject({
      kind: 'FUND',
      operationId: preparedFund.operationId,
      jobId: created.body.id,
      agreementId: created.body.agreementId,
      externalJobId: '123',
      amount: created.body.settlement.totalAmount,
    })

    const fundedRows = await sql<
      {
        fund_status: string
        settlement_state: string
        chain_events: string
        marketplace_events: string
      }[]
    >`
      SELECT
        (SELECT status FROM settlement_operations WHERE id = ${preparedFund.operationId})
          AS fund_status,
        (SELECT settlement_state FROM marketplace_jobs WHERE id = ${created.body.id})
          AS settlement_state,
        (SELECT count(*) FROM chain_events
          WHERE transaction_hash = ${submittedFundHash}
            AND event_name = 'JobFunded') AS chain_events,
        (SELECT count(*) FROM marketplace_events
          WHERE job_id = ${created.body.id}
            AND event_type = 'SETTLEMENT_FUNDED') AS marketplace_events
    `
    expect(fundedRows[0]).toEqual({
      fund_status: 'FINALIZED',
      settlement_state: 'FUNDED',
      chain_events: '1',
      marketplace_events: '1',
    })

    const wrongStarter = store.startJob(stranger, created.body.id, {
      key: 'postgres-job-start-wrong-actor',
      requestHash: hash({ jobId: created.body.id }),
    })
    await expect(wrongStarter).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })

    const started = await store.startJob(actor, created.body.id, {
      key: 'postgres-job-start',
      requestHash: hash({ jobId: created.body.id }),
    })
    expect(started.statusCode).toBe(200)
    expect(started.body).toMatchObject({
      id: created.body.id,
      workState: 'IN_PROGRESS',
      settlementState: 'FUNDED',
      providerActorId: actorProfileId,
      nextAction: 'SUBMIT_WORK',
    })

    const startRows = await sql<
      {
        work_state: string
        settlement_state: string
        events: string
      }[]
    >`
      SELECT
        (SELECT work_state FROM marketplace_jobs WHERE id = ${created.body.id}) AS work_state,
        (SELECT settlement_state FROM marketplace_jobs WHERE id = ${created.body.id})
          AS settlement_state,
        (SELECT count(*) FROM marketplace_events
          WHERE job_id = ${created.body.id}
            AND event_type = 'JOB_STARTED') AS events
    `
    expect(startRows[0]).toEqual({
      work_state: 'IN_PROGRESS',
      settlement_state: 'FUNDED',
      events: '1',
    })

    const replayStart = await store.startJob(actor, created.body.id, {
      key: 'postgres-job-start',
      requestHash: hash({ jobId: created.body.id }),
    })
    expect(replayStart.replayed).toBe(true)
    expect(replayStart.body).toEqual(started.body)

    const submissionInput = {
      output: {
        verdict: 'owner controls upgrade path',
        findings: [{ severity: 'medium', title: 'Proxy owner can upgrade implementation' }],
      },
      evidence: {
        sources: [
          {
            kind: 'contract-read',
            target: `0x${'12'.repeat(20)}`,
            selector: 'owner()',
          },
        ],
      },
      artifactUri: 'ipfs://bafybeigdyrzt5example',
      note: 'Submitted with cited owner evidence.',
    }
    const submittedWork = await store.submitJob(actor, created.body.id, submissionInput, {
      key: 'postgres-job-submit',
      requestHash: hash({ jobId: created.body.id, ...submissionInput }),
    })
    expect(submittedWork.statusCode).toBe(200)
    expect(submittedWork.body).toMatchObject({
      jobId: created.body.id,
      revisionNumber: 1,
      workState: 'SUBMITTED',
      settlementState: 'FUNDED',
      providerActorId: actorProfileId,
      output: submissionInput.output,
      evidence: submissionInput.evidence,
      artifactUri: submissionInput.artifactUri,
      note: submissionInput.note,
      nextAction: 'WAIT_FOR_ONCHAIN_SUBMISSION',
    })
    expect(submittedWork.body.submissionHash).toMatch(/^[0-9a-f]{64}$/)

    const submissionRows = await sql<
      {
        work_state: string
        settlement_state: string
        submissions: string
        events: string
        submit_operations: string
        submit_outbox: string
      }[]
    >`
      SELECT
        (SELECT work_state FROM marketplace_jobs WHERE id = ${created.body.id}) AS work_state,
        (SELECT settlement_state FROM marketplace_jobs WHERE id = ${created.body.id})
          AS settlement_state,
        (SELECT count(*) FROM job_submissions
          WHERE job_id = ${created.body.id}
            AND submission_hash = ${submittedWork.body.submissionHash}) AS submissions,
        (SELECT count(*) FROM marketplace_events
          WHERE job_id = ${created.body.id}
            AND event_type = 'JOB_SUBMITTED') AS events,
        (SELECT count(*) FROM settlement_operations
          WHERE job_id = ${created.body.id}
            AND operation_type = 'SUBMIT_WORK'
            AND status = 'REQUESTED') AS submit_operations,
        (SELECT count(*) FROM outbox_events
          WHERE aggregate_id = ${created.body.id}
            AND topic = 'marketplace.settlement.submit.requested') AS submit_outbox
    `
    expect(submissionRows[0]).toEqual({
      work_state: 'SUBMITTED',
      settlement_state: 'FUNDED',
      submissions: '1',
      events: '1',
      submit_operations: '1',
      submit_outbox: '1',
    })

    const replaySubmission = await store.submitJob(actor, created.body.id, submissionInput, {
      key: 'postgres-job-submit',
      requestHash: hash({ jobId: created.body.id, ...submissionInput }),
    })
    expect(replaySubmission.replayed).toBe(true)
    expect(replaySubmission.body).toEqual(submittedWork.body)

    const prematureReview = store.reviewJob(
      stranger,
      created.body.id,
      {
        decision: 'ACCEPT',
        note: 'Looks good.',
        requiredChanges: null,
      },
      {
        key: 'postgres-job-review-before-onchain-submit',
        requestHash: hash({ jobId: created.body.id, decision: 'ACCEPT', phase: 'premature' }),
      },
    )
    await expect(prematureReview).rejects.toMatchObject({ code: 'JOB_NOT_SUBMITTED_ONCHAIN' })

    const preparedSubmit = await worker.prepareSubmitNext('store-test')
    expect(preparedSubmit?.jobId).toBe(created.body.id)
    expect(preparedSubmit?.transaction.functionName).toBe('submit')
    expect(preparedSubmit?.transaction.to).toBe(created.body.settlement.contract)
    if (preparedSubmit?.transaction.functionName !== 'submit')
      throw new Error('Submit operation did not prepare APEX submit calldata.')
    expect(preparedSubmit.transaction.args).toEqual({
      externalJobId: '123',
      deliverable: `0x${submittedWork.body.submissionHash}`,
      optParams: '0x',
    })

    const submittedOnChain = await worker.submitNext({
      submit: async (transaction) => {
        expect(transaction).toEqual(preparedSubmit.transaction)
        return {
          transactionHash: `0x${'98'.repeat(32)}`,
          transactionNonce: '10',
        }
      },
    })
    expect(submittedOnChain?.operationId).toBe(preparedSubmit.operationId)
    expect(submittedOnChain?.transactionHash).toBe(`0x${'98'.repeat(32)}`)
    const submittedOnChainHash = submittedOnChain?.transactionHash
    if (!submittedOnChainHash)
      throw new Error('APEX submit operation did not return a transaction hash.')

    const finalizedSubmit = await worker.finalizeSubmitNext({
      finalizedReceipt: async (hash) => ({
        status: 'success',
        transactionHash: hash,
        blockNumber: 101n,
        blockHash: `0x${'97'.repeat(32)}`,
        logs: [
          {
            address: created.body.settlement.contract,
            topics: encodeEventTopics({
              abi: APEX_COMMERCE_ABI,
              eventName: 'JobSubmitted',
              args: {
                jobId: 123n,
                provider: actor.address,
              },
            }) as `0x${string}`[],
            data: encodeAbiParameters(
              [{ type: 'bytes32' }],
              [`0x${submittedWork.body.submissionHash}` as `0x${string}`],
            ),
            transactionHash: hash,
            logIndex: 5,
            blockNumber: 101n,
            blockHash: `0x${'97'.repeat(32)}`,
          },
        ],
      }),
    })
    expect(finalizedSubmit).toMatchObject({
      kind: 'SUBMIT_WORK',
      operationId: preparedSubmit.operationId,
      jobId: created.body.id,
      agreementId: created.body.agreementId,
      externalJobId: '123',
      deliverable: `0x${submittedWork.body.submissionHash}`,
    })

    const finalizedSubmitRows = await sql<
      {
        submit_status: string
        settlement_state: string
        chain_events: string
        marketplace_events: string
      }[]
    >`
      SELECT
        (SELECT status FROM settlement_operations WHERE id = ${preparedSubmit.operationId})
          AS submit_status,
        (SELECT settlement_state FROM marketplace_jobs WHERE id = ${created.body.id})
          AS settlement_state,
        (SELECT count(*) FROM chain_events
          WHERE transaction_hash = ${submittedOnChainHash}
            AND event_name = 'JobSubmitted') AS chain_events,
        (SELECT count(*) FROM marketplace_events
          WHERE job_id = ${created.body.id}
            AND event_type = 'SETTLEMENT_WORK_SUBMITTED') AS marketplace_events
    `
    expect(finalizedSubmitRows[0]).toEqual({
      submit_status: 'FINALIZED',
      settlement_state: 'DELIVERABLE_SUBMITTED',
      chain_events: '1',
      marketplace_events: '1',
    })

    const wrongReviewer = store.reviewJob(
      actor,
      created.body.id,
      {
        decision: 'ACCEPT',
        note: 'Looks good.',
        requiredChanges: null,
      },
      {
        key: 'postgres-job-review-wrong-actor',
        requestHash: hash({ jobId: created.body.id, decision: 'ACCEPT' }),
      },
    )
    await expect(wrongReviewer).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })

    const accepted = await store.reviewJob(
      stranger,
      created.body.id,
      {
        decision: 'ACCEPT',
        note: 'Accepted. Evidence matches the scope.',
        requiredChanges: null,
      },
      {
        key: 'postgres-job-review-accept',
        requestHash: hash({
          jobId: created.body.id,
          decision: 'ACCEPT',
          note: 'Accepted. Evidence matches the scope.',
          requiredChanges: null,
        }),
      },
    )
    expect(accepted.statusCode).toBe(200)
    expect(accepted.body).toMatchObject({
      jobId: created.body.id,
      submissionId: submittedWork.body.id,
      revisionNumber: 1,
      reviewerActorId: created.body.requesterActorId,
      decision: 'ACCEPT',
      workState: 'ACCEPTED',
      settlementState: 'DELIVERABLE_SUBMITTED',
      payoutState: 'HOLD',
      nextAction: 'RELEASE_PAYMENT',
    })
    expect(accepted.body.reviewHash).toMatch(/^[0-9a-f]{64}$/)

    const reviewRows = await sql<
      {
        work_state: string
        payout_state: string
        reviews: string
        events: string
        release_operations: string
        release_outbox: string
      }[]
    >`
      SELECT
        (SELECT work_state FROM marketplace_jobs WHERE id = ${created.body.id}) AS work_state,
        (SELECT payout_state FROM marketplace_jobs WHERE id = ${created.body.id}) AS payout_state,
        (SELECT count(*) FROM job_reviews
          WHERE job_id = ${created.body.id}
            AND review_hash = ${accepted.body.reviewHash}) AS reviews,
        (SELECT count(*) FROM marketplace_events
          WHERE job_id = ${created.body.id}
            AND event_type = 'JOB_ACCEPTED') AS events,
        (SELECT count(*) FROM settlement_operations
          WHERE job_id = ${created.body.id}
            AND operation_type = 'RELEASE'
            AND status = 'REQUESTED') AS release_operations,
        (SELECT count(*) FROM outbox_events
          WHERE aggregate_id = ${created.body.id}
            AND topic = 'marketplace.settlement.release.requested') AS release_outbox
    `
    expect(reviewRows[0]).toEqual({
      work_state: 'ACCEPTED',
      payout_state: 'HOLD',
      reviews: '1',
      events: '1',
      release_operations: '1',
      release_outbox: '1',
    })

    const replayAccepted = await store.reviewJob(
      stranger,
      created.body.id,
      {
        decision: 'ACCEPT',
        note: 'Accepted. Evidence matches the scope.',
        requiredChanges: null,
      },
      {
        key: 'postgres-job-review-accept',
        requestHash: hash({
          jobId: created.body.id,
          decision: 'ACCEPT',
          note: 'Accepted. Evidence matches the scope.',
          requiredChanges: null,
        }),
      },
    )
    expect(replayAccepted.replayed).toBe(true)
    expect(replayAccepted.body).toEqual(accepted.body)

    const preparedRelease = await worker.prepareReleaseNext('store-test')
    expect(preparedRelease?.jobId).toBe(created.body.id)
    expect(preparedRelease?.transaction.functionName).toBe('complete')
    expect(preparedRelease?.transaction.data.startsWith('0xd75bbdf3')).toBe(true)
    expect(preparedRelease?.transaction.to).toBe(created.body.settlement.contract)
    if (preparedRelease?.transaction.functionName !== 'complete')
      throw new Error('Release operation did not prepare APEX complete calldata.')
    expect(preparedRelease.transaction.args).toEqual({
      externalJobId: '123',
      reason: `0x${accepted.body.reviewHash}`,
      optParams: '0x',
    })

    const preparedReleaseRows = await sql<
      {
        status: string
        amount: string
        outbox_status: string
      }[]
    >`
      SELECT
        so.status,
        so.amount,
        o.status AS outbox_status
      FROM settlement_operations so
      JOIN outbox_events o ON o.dedupe_key = so.logical_key
      WHERE so.id = ${preparedRelease.operationId}
    `
    expect(preparedReleaseRows[0]).toEqual({
      status: 'PREPARED',
      amount: created.body.settlement.providerAmount,
      outbox_status: 'DELIVERED',
    })

    const submittedRelease = await worker.submitNext({
      submit: async (transaction) => {
        expect(transaction).toEqual(preparedRelease.transaction)
        return {
          transactionHash: `0x${'99'.repeat(32)}`,
          transactionNonce: '9',
        }
      },
    })
    expect(submittedRelease?.operationId).toBe(preparedRelease.operationId)
    expect(submittedRelease?.transactionHash).toBe(`0x${'99'.repeat(32)}`)

    const releaseSubmittedRows = await sql<
      {
        operation_status: string
        settlement_state: string
        payout_state: string
        events: string
      }[]
    >`
      SELECT
        (SELECT status FROM settlement_operations WHERE id = ${preparedRelease.operationId})
          AS operation_status,
        (SELECT settlement_state FROM marketplace_jobs WHERE id = ${created.body.id})
          AS settlement_state,
        (SELECT payout_state FROM marketplace_jobs WHERE id = ${created.body.id}) AS payout_state,
        (SELECT count(*) FROM marketplace_events
          WHERE job_id = ${created.body.id}
            AND event_type = 'SETTLEMENT_RELEASE_SUBMITTED') AS events
    `
    expect(releaseSubmittedRows[0]).toEqual({
      operation_status: 'SUBMITTED',
      settlement_state: 'RELEASE_SUBMITTED',
      payout_state: 'HOLD',
      events: '1',
    })

    const submittedReleaseHash = submittedRelease?.transactionHash
    if (!submittedReleaseHash)
      throw new Error('Release submission did not return a transaction hash.')
    const finalizedRelease = await worker.finalizeReleaseNext({
      finalizedReceipt: async (hash) => ({
        status: 'success',
        transactionHash: hash,
        blockNumber: 102n,
        blockHash: `0x${'aa'.repeat(32)}`,
        logs: [
          {
            address: created.body.settlement.contract,
            topics: encodeEventTopics({
              abi: APEX_COMMERCE_ABI,
              eventName: 'JobCompleted',
              args: {
                jobId: 123n,
                evaluator:
                  BSC_MAINNET.contracts.erc8183EvaluatorRouter.toLowerCase() as `0x${string}`,
              },
            }) as `0x${string}`[],
            data: encodeAbiParameters(
              [{ type: 'bytes32' }],
              [`0x${accepted.body.reviewHash}` as `0x${string}`],
            ),
            transactionHash: hash,
            logIndex: 5,
            blockNumber: 102n,
            blockHash: `0x${'aa'.repeat(32)}`,
          },
          {
            address: created.body.settlement.contract,
            topics: encodeEventTopics({
              abi: APEX_COMMERCE_ABI,
              eventName: 'PaymentReleased',
              args: { jobId: 123n, provider: actor.address },
            }) as `0x${string}`[],
            data: encodeAbiParameters(
              [{ type: 'uint256' }],
              [BigInt(created.body.settlement.providerAmount)],
            ),
            transactionHash: hash,
            logIndex: 6,
            blockNumber: 102n,
            blockHash: `0x${'aa'.repeat(32)}`,
          },
        ],
      }),
    })
    expect(finalizedRelease).toMatchObject({
      kind: 'RELEASE',
      operationId: preparedRelease.operationId,
      jobId: created.body.id,
      agreementId: created.body.agreementId,
      externalJobId: '123',
      amount: created.body.settlement.providerAmount,
    })

    const releasedRows = await sql<
      {
        operation_status: string
        settlement_state: string
        payout_state: string
        completed_events: string
        released_events: string
        marketplace_events: string
      }[]
    >`
      SELECT
        (SELECT status FROM settlement_operations WHERE id = ${preparedRelease.operationId})
          AS operation_status,
        (SELECT settlement_state FROM marketplace_jobs WHERE id = ${created.body.id})
          AS settlement_state,
        (SELECT payout_state FROM marketplace_jobs WHERE id = ${created.body.id}) AS payout_state,
        (SELECT count(*) FROM chain_events
          WHERE transaction_hash = ${submittedReleaseHash}
            AND event_name = 'JobCompleted') AS completed_events,
        (SELECT count(*) FROM chain_events
          WHERE transaction_hash = ${submittedReleaseHash}
            AND event_name = 'PaymentReleased') AS released_events,
        (SELECT count(*) FROM marketplace_events
          WHERE job_id = ${created.body.id}
            AND event_type = 'SETTLEMENT_RELEASED') AS marketplace_events
    `
    expect(releasedRows[0]).toEqual({
      operation_status: 'FINALIZED',
      settlement_state: 'RELEASED',
      payout_state: 'PAID',
      completed_events: '1',
      released_events: '1',
      marketplace_events: '1',
    })
    const releasedJobRead = await store.getJob(stranger, created.body.id)
    expect(releasedJobRead).toMatchObject({
      id: created.body.id,
      workState: 'ACCEPTED',
      settlementState: 'RELEASED',
      payoutState: 'PAID',
      nextAction: 'VIEW_RECEIPT',
    })
  })
})
