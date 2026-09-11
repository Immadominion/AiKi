import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BSC_MAINNET } from '../config/chains.js'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { prepareApexComplete, prepareApexFund, prepareApexSubmit } from './apex.js'
import { hashCanonicalJson } from './canonical-json.js'
import type { ActorIdentity, CreateOffer, JsonValue } from './model.js'
import { buildJobPreview } from './preview.js'
import { settlementRailFor } from './settlement-rails.js'
import { PostgresMarketplaceSettlementWorker } from './settlement-worker.js'
import { PostgresMarketplaceStore } from './store.js'

const databaseUrl = process.env.DATABASE_URL
const hash = (value: unknown) => hashCanonicalJson(value as JsonValue)
const provider: ActorIdentity = { chainId: 56, address: `0x${'14'.repeat(20)}` }
const buyer: ActorIdentity = { chainId: 56, address: `0x${'25'.repeat(20)}` }
const rail = settlementRailFor({
  chainId: 56,
  token: BSC_MAINNET.contracts.settlementToken,
  decimals: 18,
})

describe.skipIf(!databaseUrl)('durable settlement submission uncertainty', () => {
  const schema = `settlement_submission_qa_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql
  let sql: postgres.Sql
  let store: PostgresMarketplaceStore
  let worker: PostgresMarketplaceSettlementWorker
  let workerUrl: string
  const otherWorkers: PostgresMarketplaceSettlementWorker[] = []

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Missing isolated local test database URL')
    const url = new URL(databaseUrl)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Settlement submission regressions require a loopback test database')
    admin = postgres(databaseUrl, {
      max: 1,
      connect_timeout: 5,
      onnotice: () => {},
      connection: { statement_timeout: 10_000 },
    })
    await admin`CREATE SCHEMA ${admin(schema)}`
    url.searchParams.set('search_path', schema)
    workerUrl = url.toString()
    sql = postgres(workerUrl, { max: 1, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    store = new PostgresMarketplaceStore(workerUrl)
    worker = new PostgresMarketplaceSettlementWorker(workerUrl)
  }, 30_000)

  afterAll(async () => {
    try {
      await Promise.all([
        store?.close(),
        worker?.close(),
        ...otherWorkers.map((other) => other.close()),
        sql?.end({ timeout: 5 }),
      ])
    } finally {
      if (admin) {
        try {
          await admin`DROP SCHEMA ${admin(schema)} CASCADE`
        } finally {
          await admin.end({ timeout: 5 })
        }
      }
    }
  })

  async function prepared(
    kind: 'CREATE_ESCROW' | 'FUND' | 'SUBMIT_WORK' | 'RELEASE' = 'CREATE_ESCROW',
  ) {
    const key = randomUUID()
    const profile = {
      displayName: 'Submission safety fixture',
      summary: 'Local mocked transport only.',
      availability: 'AVAILABLE' as const,
      capacity: 2,
      supportedProtocols: ['erc-8183'],
      geography: {},
    }
    await store.putProvider(provider, profile, {
      key: `${key}:provider`,
      requestHash: hash(profile),
    })
    const offer: CreateOffer = {
      title: 'A local test report',
      summary: 'No provider is called.',
      capabilityTags: ['report'],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      evidenceSchema: { type: 'object' },
      pricingModel: 'FIXED',
      settlementChainId: 56,
      settlementToken: rail.token,
      settlementDecimals: 18,
      amount: '100000000000000000',
      platformFeeBps: 250,
      deliverySlaSeconds: 3600,
      reviewSlaSeconds: 7200,
      includedRevisions: 0,
      concurrentCapacity: 2,
      dispatchMethod: 'MANUAL',
      dispatchEndpoint: null,
      failoverSafe: false,
    }
    const published = await store.createOffer(provider, offer, {
      key: `${key}:offer`,
      requestHash: hash(offer),
    })
    const input = {
      offerId: published.body.id,
      offerVersion: published.body.version,
      brief: 'Test submission uncertainty.',
      requirements: {},
      definitionOfDone: 'A fixture document.',
      evidenceRequirements: {},
    }
    const preview = buildJobPreview(published.body, input)
    const request = { ...input, previewHash: preview.previewHash }
    const job = await store.createJob(buyer, request, {
      key: `${key}:job`,
      requestHash: hash(request),
    })
    const operation = await worker.prepareNext()
    expect(operation?.jobId).toBe(job.body.id)
    if (!operation) throw new Error('Expected one prepared fixture operation')
    const transaction =
      kind === 'FUND'
        ? prepareApexFund({ rail, externalJobId: '1', amount: '100000000000000000' })
        : kind === 'SUBMIT_WORK'
          ? prepareApexSubmit({ rail, externalJobId: '1', deliverable: 'ab'.repeat(32) })
          : kind === 'RELEASE'
            ? prepareApexComplete({ rail, externalJobId: '1', reason: 'cd'.repeat(32) })
            : operation.transaction
    await sql`UPDATE settlement_operations SET operation_type = ${kind}, prepared_transaction = ${sql.json(transaction)} WHERE id = ${operation.operationId}`
    return { ...operation, transaction }
  }

  it.each(['CREATE_ESCROW', 'FUND', 'SUBMIT_WORK', 'RELEASE'] as const)(
    'never requeues ambiguous %s sends after a lost acknowledgement or worker restart',
    async (kind) => {
      const operation = await prepared(kind)
      const submit = vi.fn(async () => {
        throw new Error('Transport lost acknowledgement; sensitive URL must not escape')
      })
      const failure = await worker.submitNext({ submit }).catch((error: unknown) => error)
      const rows =
        await sql`SELECT status, failure_code, failure_detail, transaction_hash, prepared_transaction FROM settlement_operations WHERE id = ${operation.operationId}`
      expect(rows[0]).toMatchObject({
        status: 'SUBMITTING',
        failure_code: 'SUBMISSION_UNCONFIRMED',
        transaction_hash: null,
        prepared_transaction: operation.transaction,
      })
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('Settlement submission is unconfirmed')
      expect(rows[0]?.failure_detail).not.toContain('sensitive URL')
      const restarted = new PostgresMarketplaceSettlementWorker(workerUrl)
      otherWorkers.push(restarted)
      expect(await restarted.submitNext({ submit })).toBeNull()
      expect(await worker.submitNext({ submit })).toBeNull()
      expect(submit).toHaveBeenCalledOnce()
    },
  )

  it('commits the claim before transport and excludes a concurrent independent worker', async () => {
    const operation = await prepared()
    const competitor = new PostgresMarketplaceSettlementWorker(workerUrl)
    otherWorkers.push(competitor)
    const secondSend = vi.fn()
    const submit = vi.fn(async () => {
      expect(
        (await sql`SELECT status FROM settlement_operations WHERE id = ${operation.operationId}`)[0]
          ?.status,
      ).toBe('SUBMITTING')
      expect(await competitor.submitNext({ submit: secondSend })).toBeNull()
      throw new Error('Unknown broadcast outcome')
    })
    await expect(worker.submitNext({ submit })).rejects.toThrow(
      'Settlement submission is unconfirmed',
    )
    expect(secondSend).not.toHaveBeenCalled()
    expect(await competitor.submitNext({ submit: secondSend })).toBeNull()
  })

  it('keeps malformed returned hashes unresolved without another send', async () => {
    const operation = await prepared()
    const submit = vi.fn(async () => ({
      transactionHash: '0x1234' as const,
      transactionNonce: null,
    }))
    await expect(worker.submitNext({ submit })).rejects.toThrow(
      'Settlement submission is unconfirmed',
    )
    expect(
      (
        await sql`SELECT status, transaction_hash FROM settlement_operations WHERE id = ${operation.operationId}`
      )[0],
    ).toEqual({ status: 'SUBMITTING', transaction_hash: null })
    expect(await worker.submitNext({ submit })).toBeNull()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('does not resend when the transport returns a hash but recording it fails', async () => {
    const operation = await prepared()
    await sql.unsafe(`CREATE FUNCTION fail_hash_recording() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${operation.operationId}'::uuid AND NEW.status = 'SUBMITTED' THEN
          RAISE EXCEPTION 'Sensitive database acknowledgement detail';
        END IF;
        RETURN NEW;
      END;
    $$`)
    await sql.unsafe(
      'CREATE TRIGGER fail_hash_recording BEFORE UPDATE ON settlement_operations FOR EACH ROW EXECUTE FUNCTION fail_hash_recording()',
    )
    const submit = vi.fn(async () => ({
      transactionHash: `0x${'36'.repeat(32)}` as const,
      transactionNonce: '6',
    }))
    try {
      await expect(worker.submitNext({ submit })).rejects.toThrow(
        'Settlement submission is unconfirmed',
      )
      expect(
        (
          await sql`SELECT status, transaction_hash, prepared_transaction FROM settlement_operations WHERE id = ${operation.operationId}`
        )[0],
      ).toEqual({
        status: 'SUBMITTING',
        transaction_hash: null,
        prepared_transaction: operation.transaction,
      })
      const restarted = new PostgresMarketplaceSettlementWorker(workerUrl)
      otherWorkers.push(restarted)
      expect(await restarted.submitNext({ submit })).toBeNull()
      expect(submit).toHaveBeenCalledOnce()
    } finally {
      await sql.unsafe('DROP TRIGGER fail_hash_recording ON settlement_operations')
      await sql.unsafe('DROP FUNCTION fail_hash_recording()')
    }
  })

  it('records an acknowledged exact hash once and never submits it again', async () => {
    const operation = await prepared()
    const result = { transactionHash: `0x${'47'.repeat(32)}` as const, transactionNonce: '7' }
    const submit = vi.fn(async () => result)
    expect(await worker.submitNext({ submit })).toMatchObject({
      operationId: operation.operationId,
      ...result,
    })
    expect(
      (
        await sql`SELECT status, transaction_hash, transaction_nonce FROM settlement_operations WHERE id = ${operation.operationId}`
      )[0],
    ).toEqual({
      status: 'SUBMITTED',
      transaction_hash: result.transactionHash,
      transaction_nonce: '7',
    })
    expect(await worker.submitNext({ submit })).toBeNull()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('preserves an already committed hash when its database acknowledgement is lost', async () => {
    const operation = await prepared()
    // Fault injection only: real PostgreSQL commits both transactions, but the
    // second acknowledgement is lost to the caller after the hash is durable.
    const connection = (
      worker as unknown as {
        sql: { begin(run: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<unknown> }
      }
    ).sql
    const begin = connection.begin.bind(connection)
    let calls = 0
    const fault = vi.spyOn(connection, 'begin').mockImplementation(async (run) => {
      const result = await begin(run)
      if (++calls === 2) throw new Error('Sensitive committed database acknowledgement detail')
      return result
    })
    const result = { transactionHash: `0x${'58'.repeat(32)}` as const, transactionNonce: '8' }
    const submit = vi.fn(async () => result)
    try {
      await expect(worker.submitNext({ submit })).rejects.toThrow(
        'Settlement submission is unconfirmed',
      )
    } finally {
      fault.mockRestore()
    }
    expect(
      (
        await sql`SELECT status, transaction_hash, transaction_nonce, failure_code FROM settlement_operations WHERE id = ${operation.operationId}`
      )[0],
    ).toEqual({
      status: 'SUBMITTED',
      transaction_hash: result.transactionHash,
      transaction_nonce: '8',
      failure_code: null,
    })
    expect(await worker.submitNext({ submit })).toBeNull()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('keeps the claim locked and errors sanitized even when the diagnostic write also fails', async () => {
    const operation = await prepared()
    await sql.unsafe(`CREATE FUNCTION fail_uncertainty_note() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${operation.operationId}'::uuid AND NEW.failure_code = 'SUBMISSION_UNCONFIRMED' THEN
          RAISE EXCEPTION 'Sensitive diagnostic database detail';
        END IF;
        RETURN NEW;
      END;
    $$`)
    await sql.unsafe(
      'CREATE TRIGGER fail_uncertainty_note BEFORE UPDATE ON settlement_operations FOR EACH ROW EXECUTE FUNCTION fail_uncertainty_note()',
    )
    const submit = vi.fn(async () => {
      throw new Error('Sensitive transport detail')
    })
    try {
      await expect(worker.submitNext({ submit })).rejects.toThrow(
        'Settlement submission is unconfirmed',
      )
      expect(
        (
          await sql`SELECT status, transaction_hash, prepared_transaction FROM settlement_operations WHERE id = ${operation.operationId}`
        )[0],
      ).toEqual({
        status: 'SUBMITTING',
        transaction_hash: null,
        prepared_transaction: operation.transaction,
      })
      expect(await worker.submitNext({ submit })).toBeNull()
      expect(submit).toHaveBeenCalledOnce()
    } finally {
      await sql.unsafe('DROP TRIGGER fail_uncertainty_note ON settlement_operations')
      await sql.unsafe('DROP FUNCTION fail_uncertainty_note()')
    }
  })
})
