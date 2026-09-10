import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { keccak256 } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { PostgresExecutionRecoveryStore } from '../execution/reconcile-store.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { encodeStrategyOperation, strategyOperationDigest } from './operation.js'
import type { VerifiedStrategyReceipt } from './receipt.js'
import { a, fixture, h, yieldOp } from './receipt.test-support.js'
import { simulationFixture } from './simulation.test-support.js'
import { snapshotFixture } from './snapshot.test-support.js'
import { PostgresStrategyStore } from './store.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: { manager: string; managerCodeHash: string } }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x60006000') } }
})

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('strategy attempts and recovery in isolated PostgreSQL', () => {
  const schema = `strategy_qa_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql, sql: postgres.Sql, store: PostgresStrategyStore
  let legacy: PostgresJobStore, jobs: JobService, scopedUrl: string

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Missing isolated test database URL')
    admin = postgres(databaseUrl, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl)
    url.searchParams.set('search_path', schema)
    scopedUrl = url.toString()
    sql = postgres(scopedUrl, { max: 5, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS schema`)[0]?.schema).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    store = new PostgresStrategyStore(sql)
    legacy = new PostgresJobStore(scopedUrl)
    jobs = new JobService(legacy)
  }, 30_000)
  afterEach(async () => {
    // Only these three tables in the unique test schema, never production data.
    await sql`TRUNCATE strategy_operations, strategy_watches, execution_attempts`
  })
  afterAll(async () => {
    await legacy?.close()
    await sql?.end()
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })

  async function setup(active = true) {
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000).toISOString()
    const f = fixture({ ...yieldOp, deadline: BigInt(Math.floor(Date.now() / 1000) + 120) })
    const auth = await jobs.authorize(
      [{ kind: 'expiry', label: 'Expiry', value: expiresAt, tier: 'T0' }],
      a('99'),
    )
    const job = await jobs.createJob(auth.id, randomUUID())
    await sql`UPDATE authorizations SET status = 'active', delegator = ${f.target.operation.binding.controller},
      delegation_chain_id = 56, delegation = ${sql.json({ ...f.delegation, salt: '1', epoch: '0' })}
      WHERE id = ${auth.id}`
    const registration = {
      jobId: job.id,
      binding: f.target.operation.binding,
      manager: f.target.manager,
      executor: f.target.executor,
      bindingEnforcer: a('34'),
      expiresAt,
      policy: { maxMove: '100', minIdle: '10' },
      gasLimitWei: 100_000_000_000_000n,
    }
    const { snapshot, simulation } = await simulationFixture(f.target.operation, f.delegation)
    const snapshotJson = JSON.parse(
      JSON.stringify(snapshot, (_key, child) =>
        typeof child === 'bigint' ? child.toString() : child,
      ),
    )
    const watchId = await store.registerPaused(registration)
    if (active)
      await sql`UPDATE strategy_watches SET status = 'ACTIVE', checkpoint_nonce = 7,
      chain_snapshot = ${sql.json(snapshotJson)}, snapshot_block = ${snapshot.block.number.toString()}, snapshot_hash = ${snapshot.block.hash},
      snapshot_timestamp = to_timestamp(${snapshot.block.timestamp.toString()}::double precision) WHERE id = ${watchId}`
    const begin = (instance = store) =>
      instance.begin({
        watchId,
        expectedRevision: '0',
        operation: f.target.operation,
        envelopeHash: f.target.envelopeHash,
        manager: f.target.manager,
        executor: f.target.executor,
        simulation,
        gasBudgetWei: 6_000_000_000_000n,
      })
    const claim = async () => {
      const result = await begin()
      if (!result.acquired) throw new Error(`Test claim failed: ${result.reason}`)
      return result.attemptId
    }
    const evidence = async () => {
      const result = await f.run()
      if (result.status !== 'verified') throw new Error('Invalid test chain fixture')
      return result.receipt
    }
    return { ...f, auth, job, watchId, registration, begin, claim, evidence, simulation }
  }

  async function chainProof(
    f: Awaited<ReturnType<typeof setup>>,
    options: Parameters<typeof snapshotFixture>[1] = {},
    unfunded = false,
  ) {
    const fixture = snapshotFixture('yield', {
      binding: f.target.operation.binding,
      owner: a('99'),
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      expiresAt: BigInt(Date.parse(f.registration.expiresAt) / 1000),
      managerCode: '0x60006000',
      vaultCode: '0x60006000',
      ...options,
    })
    if (unfunded)
      for (const name of ['managedIdle', 'managedVenusShares', 'managedAaveScaled'])
        fixture.setVault(name, 0n)
    const result = await fixture.run()
    if (result.status !== 'verified') throw new Error('Invalid test snapshot fixture')
    return result.snapshot
  }

  it('requires an explicit matching owner to start from fresh verified, funded, unpaused chain state', async () => {
    const f = await setup(false),
      snapshot = await chainProof(f)
    expect(
      await store.syncSnapshot({ watchId: f.watchId, expectedRevision: '0', snapshot }),
    ).toEqual({ status: 'applied', revision: '1', active: false })
    expect(
      await store.syncSnapshot({
        watchId: f.watchId,
        expectedRevision: '1',
        snapshot,
        activateOwner: a('ab'),
      }),
    ).toEqual({ status: 'not_ready' })
    expect(
      await store.syncSnapshot({
        watchId: f.watchId,
        expectedRevision: '1',
        snapshot,
        activateOwner: a('99'),
      }),
    ).toEqual({ status: 'applied', revision: '2', active: true })
    expect(
      await store.begin({
        watchId: f.watchId,
        expectedRevision: '2',
        operation: f.target.operation,
        envelopeHash: f.target.envelopeHash,
        manager: f.target.manager,
        executor: f.target.executor,
        simulation: (await simulationFixture(f.target.operation, f.delegation, snapshot))
          .simulation,
        gasBudgetWei: 6_000_000_000_000n,
      }),
    ).toMatchObject({ acquired: true })
  })
  it('rejects forged or stale snapshots and refuses unfunded/paused activation', async () => {
    const f = await setup(false),
      snapshot = await chainProof(f)
    await expect(
      store.syncSnapshot({ watchId: f.watchId, expectedRevision: '0', snapshot: { ...snapshot } }),
    ).rejects.toThrow('verified strategy snapshot')
    for (const proof of [
      await chainProof(f, { timestamp: BigInt(Math.floor(Date.now() / 1000) - 60) }),
      await chainProof(f, { paused: true }),
      await chainProof(f, {}, true),
    ])
      expect(
        await store.syncSnapshot({
          watchId: f.watchId,
          expectedRevision: '0',
          snapshot: proof,
          activateOwner: a('99'),
        }),
      ).toEqual({ status: 'not_ready' })
  })
  it('never rewrites a pending operation checkpoint from a newer snapshot', async () => {
    const f = await setup()
    await f.claim()
    expect(
      await store.syncSnapshot({
        watchId: f.watchId,
        expectedRevision: '0',
        snapshot: await chainProof(f, { nonce: 99n }),
      }),
    ).toEqual({ status: 'pending' })
    expect(
      (await sql`SELECT checkpoint_nonce::text FROM strategy_watches WHERE id = ${f.watchId}`)[0]
        ?.checkpoint_nonce,
    ).toBe('7')
  })
  it('does not automatically restart a review-required watch when fresh state becomes readable', async () => {
    const f = await setup(false)
    await sql`UPDATE strategy_watches SET status = 'NEEDS_REVIEW' WHERE id = ${f.watchId}`
    expect(
      await store.syncSnapshot({
        watchId: f.watchId,
        expectedRevision: '0',
        snapshot: await chainProof(f),
      }),
    ).toEqual({ status: 'applied', revision: '1', active: false })
  })
  it('refuses rollback to an earlier finalized snapshot or a different account owner', async () => {
    const f = await setup(false)
    await store.syncSnapshot({
      watchId: f.watchId,
      expectedRevision: '0',
      snapshot: await chainProof(f, { blockNumber: 200n }),
    })
    expect(
      await store.syncSnapshot({
        watchId: f.watchId,
        expectedRevision: '1',
        snapshot: await chainProof(f, { blockNumber: 199n }),
      }),
    ).toEqual({ status: 'not_ready' })
    expect(
      await store.syncSnapshot({
        watchId: f.watchId,
        expectedRevision: '1',
        snapshot: await chainProof(f, { owner: a('ab') }),
      }),
    ).toEqual({ status: 'changed' })
  })

  it('registers paused and refuses execution until explicit verified activation', async () => {
    const f = await setup(false)
    expect(await f.begin()).toEqual({ acquired: false, reason: 'not_ready' })
    expect(await sql`SELECT id FROM execution_attempts`).toHaveLength(0)
  })
  it('replays identical registration without resetting state and refuses different configuration', async () => {
    const f = await setup()
    expect(await store.registerPaused(f.registration)).toBe(f.watchId)
    await expect(store.registerPaused({ ...f.registration, executor: a('ab') })).rejects.toThrow(
      'cannot replace',
    )
    expect(
      (await sql`SELECT status FROM strategy_watches WHERE id = ${f.watchId}`)[0]?.status,
    ).toBe('ACTIVE')
  })
  it('treats reordered nested JSONB policy keys as the same registration', async () => {
    const f = await setup(false)
    const policy = {
      twapWindow: 300,
      maxDeviationTicks: 200,
      minPoolLiquidity: '1000000000000',
      nested: { z: 1, a: 2 },
    }
    await sql`UPDATE strategy_watches SET policy = ${sql.json(policy)} WHERE id = ${f.watchId}`
    expect(await store.registerPaused({ ...f.registration, policy })).toBe(f.watchId)
    expect(
      await store.registerPaused({
        ...f.registration,
        policy: { ...policy, nested: { a: 2, z: 1 } },
      }),
    ).toBe(f.watchId)
  })
  it('closes only a known pre-broadcast refusal, without fabricating a chain receipt', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.refuseBeforeBroadcast(id)
    expect(
      (
        await sql`SELECT state, verified_receipt FROM strategy_operations WHERE attempt_id = ${id}`
      )[0],
    ).toMatchObject({ state: 'REFUSED', verified_receipt: null })
    expect(
      (await sql`SELECT status FROM strategy_watches WHERE id = ${f.watchId}`)[0]?.status,
    ).toBe('NEEDS_REVIEW')
  })
  it('refuses a changed signed permission even when controller and executor are unchanged', async () => {
    const f = await setup()
    await sql`UPDATE authorizations SET delegation = jsonb_set(delegation, '{salt}', '"2"') WHERE id = ${f.auth.id}`
    expect(await f.begin()).toEqual({ acquired: false, reason: 'changed' })
    expect(await sql`SELECT id FROM execution_attempts`).toHaveLength(0)
  })
  it('binds each gas budget to the registered ceiling and exact issued simulation', async () => {
    const f = await setup()
    const request = {
      watchId: f.watchId,
      expectedRevision: '0',
      operation: f.target.operation,
      envelopeHash: f.target.envelopeHash,
      manager: f.target.manager,
      executor: f.target.executor,
      simulation: f.simulation,
      gasBudgetWei: f.registration.gasLimitWei + 1n,
    }
    expect(await store.begin(request)).toEqual({ acquired: false, reason: 'not_ready' })
    await expect(store.begin({ ...request, gasBudgetWei: 1n })).rejects.toThrow(
      'Invalid prepared operation',
    )
    await expect(store.begin({ ...request, simulation: { ...f.simulation } })).rejects.toThrow(
      'Invalid prepared operation',
    )
    expect(await sql`SELECT id FROM execution_attempts`).toHaveLength(0)
  })
  it('rechecks pause, revocation, exact permission and freshness immediately before admitting a prepared hash', async () => {
    for (const change of ['pause', 'revoke', 'permission', 'expired', 'stale', 'job']) {
      const f = await setup(),
        id = await f.claim()
      if (change === 'pause') await store.pause(f.watchId, a('99'))
      if (change === 'revoke')
        await sql`UPDATE authorizations SET status = 'revoked' WHERE id = ${f.auth.id}`
      if (change === 'permission')
        await sql`UPDATE authorizations SET delegation = jsonb_set(delegation, '{salt}', '"2"') WHERE id = ${f.auth.id}`
      if (change === 'expired')
        await sql`UPDATE authorizations SET expires_at = now() - interval '1 second' WHERE id = ${f.auth.id}`
      if (change === 'stale')
        await sql`UPDATE strategy_watches SET snapshot_timestamp = now() - interval '31 seconds' WHERE id = ${f.watchId}`
      if (change === 'job') await sql`UPDATE jobs SET status = 'CANCELLED' WHERE id = ${f.job.id}`
      await expect(store.recordHash(id, f.target.transactionHash)).rejects.toThrow(
        'before broadcast admission',
      )
      expect(
        (await sql`SELECT state, transaction_hash FROM execution_attempts WHERE id = ${id}`)[0],
      ).toMatchObject({ state: 'PREPARING', transaction_hash: null })
      await sql`TRUNCATE strategy_operations, strategy_watches, execution_attempts`
    }
  })
  it('loads only the exact durable pending intent for read-only recovery', async () => {
    const f = await setup(),
      id = await f.claim()
    expect(await store.getPendingAttempt(id)).toMatchObject({
      attemptId: id,
      operation: f.target.operation,
      transactionHash: null,
      envelopeHash: f.target.envelopeHash,
    })
    await store.recordHash(id, f.target.transactionHash)
    expect(await store.getPendingAttempt(id)).toMatchObject({
      transactionHash: f.target.transactionHash,
    })
    expect(await store.getPendingAttempt(randomUUID())).toBeNull()
    await store.settle(id, await f.evidence())
    expect(await store.getPendingAttempt(id)).toBeNull()
  })
  it('never converts a hash or an uncertain hashless attempt into a pre-broadcast refusal', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.requireReview(id)
    await expect(store.refuseBeforeBroadcast(id)).rejects.toThrow('known unsubmitted')
    await expect(store.recordHash(id, f.target.transactionHash)).rejects.toThrow(
      'before broadcast admission',
    )
    expect(
      (await sql`SELECT transaction_hash FROM execution_attempts WHERE id = ${id}`)[0]
        ?.transaction_hash,
    ).toBeNull()
  })
  it('rejects a terminal operation update that does not settle its execution in the same transaction', async () => {
    const f = await setup()
    const id = await f.claim()
    await expect(
      sql`UPDATE strategy_operations SET state = 'REFUSED', completed_at = now() WHERE attempt_id = ${id}`,
    ).rejects.toThrow('matching atomic execution')
  })
  it('creates exactly one operation and shared signer claim across concurrent connections', async () => {
    const f = await setup()
    const otherSql = postgres(scopedUrl, { max: 2 })
    try {
      const result = await Promise.all([f.begin(), f.begin(new PostgresStrategyStore(otherSql))])
      expect(result.filter((r) => r.acquired)).toHaveLength(1)
      expect(await sql`SELECT attempt_id FROM strategy_operations`).toHaveLength(1)
      expect(await sql`SELECT id FROM execution_attempts`).toHaveLength(1)
    } finally {
      await otherSql.end()
    }
  })
  it('shares the legacy Guardian signer lock in both directions', async () => {
    const f = await setup()
    const otherAuth = await jobs.authorize(
      [{ kind: 'session_total_cap', label: 'Cap', value: '100', tier: 'T2' }],
      a('88'),
    )
    const otherJob = await jobs.createJob(otherAuth.id, randomUUID())
    const old = await jobs.beginExecution(otherJob.id, 56, f.target.executor)
    expect(old.acquired).toBe(true)
    expect(await f.begin()).toEqual({ acquired: false, reason: 'pending' })
    await jobs.finishExecution(old.attempt.id, 'REFUSED')
    await f.claim()
    expect((await jobs.beginExecution(otherJob.id, 56, f.target.executor)).acquired).toBe(false)
  })
  it('blocks behind unresolved unknown legacy senders', async () => {
    const f = await setup()
    const otherAuth = await jobs.authorize(
      [{ kind: 'session_total_cap', label: 'Cap', value: '100', tier: 'T2' }],
      a('88'),
    )
    const otherJob = await jobs.createJob(otherAuth.id, randomUUID())
    const old = await jobs.beginExecution(otherJob.id, 56)
    expect(old.acquired).toBe(true)
    expect(await f.begin()).toEqual({ acquired: false, reason: 'pending' })
  })
  it.each([false, true])(
    'refuses the generic action path for a registered strategy, active=%s',
    async (active) => {
      const f = await setup(active)
      await expect(jobs.beginExecution(f.job.id, 56, f.target.executor)).rejects.toThrow(
        'strategy controls',
      )
      const secondJob = await jobs.createJob(f.auth.id, randomUUID())
      await expect(jobs.beginExecution(secondJob.id, 56, f.target.executor)).rejects.toThrow(
        'strategy controls',
      )
      expect(await sql`SELECT id FROM execution_attempts`).toHaveLength(0)
    },
  )
  it('serializes registration against a competing legacy claim on the same authorization', async () => {
    const f = await setup(false)
    await sql`DELETE FROM strategy_watches WHERE id = ${f.watchId}`
    const results = await Promise.allSettled([
      store.registerPaused(f.registration),
      jobs.beginExecution(f.job.id, 56, f.target.executor),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const watches = await sql`SELECT id FROM strategy_watches WHERE authorization_id = ${f.auth.id}`
    const attempts =
      await sql`SELECT id FROM execution_attempts WHERE authorization_id = ${f.auth.id}`
    expect(watches.length + attempts.length).toBe(1)
  })
  it('snapshots the full operation before an awaited lock so caller mutation cannot strand settlement', async () => {
    const f = await setup()
    const request = {
      watchId: f.watchId,
      expectedRevision: '0',
      operation: structuredClone(f.target.operation),
      envelopeHash: f.target.envelopeHash,
      manager: f.target.manager,
      executor: f.target.executor,
      simulation: f.simulation,
      gasBudgetWei: 6_000_000_000_000n,
    }
    const before = structuredClone(request.operation)
    const connection = await sql.reserve()
    let operation: ReturnType<PostgresStrategyStore['begin']> | undefined
    try {
      await connection`BEGIN`
      await connection`SELECT pg_advisory_xact_lock(1095322441, 56)`
      operation = store.begin(request)
      if (request.operation.kind === 'yield') request.operation.assets = 200n
      request.expectedRevision = '999'
      request.envelopeHash = h('ab')
      await connection`COMMIT`
      const result = await operation
      expect(result.acquired).toBe(true)
      const [stored] =
        await sql`SELECT operation, operation_digest, call_data_hash, envelope_hash FROM strategy_operations`
      expect(stored).toMatchObject({
        operation: { assets: '100' },
        operation_digest: strategyOperationDigest(before),
        call_data_hash: keccak256(encodeStrategyOperation(before)),
        envelope_hash: f.target.envelopeHash,
      })
    } finally {
      await connection`ROLLBACK`
      connection.release()
      await operation?.catch(() => {})
    }
  })
  it.each(['LANDED', 'REVERTED', 'REFUSED'] as const)(
    'prevents generic finish from unlocking strategy as %s',
    async (state) => {
      const f = await setup()
      const id = await f.claim()
      await expect(jobs.finishExecution(id, state)).rejects.toThrow('atomic verified outcome')
      expect((await sql`SELECT state FROM execution_attempts WHERE id = ${id}`)[0]?.state).toBe(
        'PREPARING',
      )
    },
  )
  it('prevents generic successful-transaction recovery from bypassing strategy verification', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.recordHash(id, f.target.transactionHash)
    const recovery = new PostgresExecutionRecoveryStore(sql),
      attempt = await recovery.get(id)
    if (!attempt) throw new Error('Missing test attempt')
    const proof = await f.evidence()
    await expect(recovery.finalizeSuccess(attempt, proof)).rejects.toThrow(
      'atomic verified outcome',
    )
  })
  it('keeps exact hash and locks across uncertainty, retry and process reconnection', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.recordHash(id, f.target.transactionHash)
    await store.recordHash(id, f.target.transactionHash)
    await expect(store.recordHash(id, h('ab'))).rejects.toThrow('cannot be replaced')
    await store.requireReview(id)
    const second = postgres(scopedUrl, { max: 1 })
    try {
      expect(
        (await second`SELECT state, transaction_hash FROM execution_attempts WHERE id = ${id}`)[0],
      ).toMatchObject({ state: 'UNCONFIRMED', transaction_hash: f.target.transactionHash })
      expect(
        (await second`SELECT status FROM strategy_watches WHERE id = ${f.watchId}`)[0]?.status,
      ).toBe('NEEDS_REVIEW')
      expect((await f.begin(new PostgresStrategyStore(second))).acquired).toBe(false)
    } finally {
      await second.end()
    }
  })
  it('atomically settles once, records actual result, leaves marketplace spend untouched', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.recordHash(id, f.target.transactionHash)
    const proof = await f.evidence()
    expect(await Promise.all([store.settle(id, proof), store.settle(id, proof)])).toEqual(
      expect.arrayContaining(['applied', 'already_settled']),
    )
    expect((await sql`SELECT state FROM execution_attempts WHERE id = ${id}`)[0]?.state).toBe(
      'LANDED',
    )
    expect(
      (
        await sql`SELECT state, verified_receipt FROM strategy_operations WHERE attempt_id = ${id}`
      )[0],
    ).toMatchObject({ state: 'LANDED', verified_receipt: { outcome: { movedAssets: '99' } } })
    expect(
      (
        await sql`SELECT checkpoint_nonce::text, revision::text FROM strategy_watches WHERE id = ${f.watchId}`
      )[0],
    ).toEqual({ checkpoint_nonce: '8', revision: '1' })
    expect((await jobs.getAuthorization(f.auth.id)).spent).toBe(0n)
  })
  it('rejects altered evidence and evidence from another exact transaction', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.recordHash(id, f.target.transactionHash)
    const proof = await f.evidence()
    await expect(
      store.settle(id, { ...proof, transactionHash: h('ab') } as VerifiedStrategyReceipt),
    ).rejects.toThrow('newly verified')
    f.target.envelopeHash = h('ab')
    expect((await f.run()).status).toBe('blocked')
  })
  it('records a canonical revert without inventing current chain state or restarting', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.recordHash(id, f.target.transactionHash)
    f.receipt.status = 'reverted'
    f.receipt.logs = []
    expect(await store.settle(id, await f.evidence())).toBe('applied')
    expect(
      (
        await sql`SELECT checkpoint_nonce::text, status FROM strategy_watches WHERE id = ${f.watchId}`
      )[0],
    ).toEqual({ checkpoint_nonce: '7', status: 'NEEDS_REVIEW' })
  })
  it('does not restart a watch paused by the owner while its transaction was pending', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.recordHash(id, f.target.transactionHash)
    expect(await store.pause(f.watchId, a('ab'))).toBe(false)
    expect(await store.pause(f.watchId, a('99'))).toBe(true)
    expect(await store.settle(id, await f.evidence())).toBe('applied')
    expect(
      (await sql`SELECT status FROM strategy_watches WHERE id = ${f.watchId}`)[0]?.status,
    ).toBe('PAUSED')
  })
  it('rolls back receipt, checkpoint and signer completion if the final audit write fails', async () => {
    const f = await setup()
    const id = await f.claim()
    await store.recordHash(id, f.target.transactionHash)
    await sql.unsafe(`CREATE FUNCTION fail_strategy_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.detail LIKE 'Strategy operation confirmed.%' THEN RAISE EXCEPTION 'fixture audit failure'; END IF;
      RETURN NEW; END; $$;
      CREATE TRIGGER fail_strategy_audit BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION fail_strategy_audit();`)
    try {
      await expect(store.settle(id, await f.evidence())).rejects.toThrow('fixture audit failure')
      expect((await sql`SELECT state FROM execution_attempts WHERE id = ${id}`)[0]?.state).toBe(
        'SUBMITTED',
      )
      expect(
        (
          await sql`SELECT state, verified_receipt FROM strategy_operations WHERE attempt_id = ${id}`
        )[0],
      ).toMatchObject({ state: 'PENDING', verified_receipt: null })
      expect(
        (await sql`SELECT checkpoint_nonce::text FROM strategy_watches WHERE id = ${f.watchId}`)[0]
          ?.checkpoint_nonce,
      ).toBe('7')
    } finally {
      await sql.unsafe(
        'DROP TRIGGER fail_strategy_audit ON job_events; DROP FUNCTION fail_strategy_audit();',
      )
    }
  })
})
