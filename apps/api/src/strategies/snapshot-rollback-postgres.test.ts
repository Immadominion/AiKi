import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { keccak256 } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { encodeStrategyOperation, strategyOperationDigest } from './operation.js'
import { a, fixture, h, yieldOp } from './receipt.test-support.js'
import { snapshotFixture } from './snapshot.test-support.js'
import { PostgresStrategyStore } from './store.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: { manager: string; managerCodeHash: string } }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x60006000') } }
})

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Snapshot rollback regressions require a loopback-only test database.')

describe.skipIf(!databaseUrl)('strategy snapshot rollback in isolated local PostgreSQL', () => {
  const schema = `strategy_rollback_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql, sql: postgres.Sql, legacy: PostgresJobStore
  let jobs: JobService, store: PostgresStrategyStore
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Missing local test database')
    admin = postgres(databaseUrl, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const scoped = new URL(databaseUrl)
    scoped.searchParams.set('search_path', schema)
    sql = postgres(scoped.toString(), { max: 5, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    legacy = new PostgresJobStore(scoped.toString())
    jobs = new JobService(legacy)
    store = new PostgresStrategyStore(sql)
  }, 30_000)
  afterEach(async () => {
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

  async function setup() {
    const now = Math.floor(Date.now() / 1000),
      expiry = now + 86_400
    const receipt = fixture({ ...yieldOp, deadline: BigInt(now + 120) })
    const auth = await jobs.authorize(
      [
        {
          kind: 'expiry',
          label: 'Expiry',
          value: new Date(expiry * 1000).toISOString(),
          tier: 'T0',
        },
      ],
      a('99'),
    )
    const job = await jobs.createJob(auth.id, randomUUID()),
      watchId = randomUUID()
    const b = receipt.target.operation.binding
    await sql`INSERT INTO strategy_watches
      (id,authorization_id,job_id,chain_id,vault,controller,policy_hash,runtime_code_hash,kind,manager,executor,
       checkpoint_nonce,checkpoint,policy,gas_limit_wei,expires_at,binding_enforcer)
      VALUES (${watchId},${auth.id},${job.id},56,${b.vault},${b.controller},${b.policyHash},${b.runtimeCodeHash},'yield',
       ${receipt.target.manager},${receipt.target.executor},0,'{}'::jsonb,'{}'::jsonb,100000000000000,to_timestamp(${expiry}),${a('34')})`
    const proof = async (nonce: bigint, blockNumber = 90n, blockHash = h('90')) => {
      const f = snapshotFixture('yield', {
        binding: b,
        owner: a('99'),
        timestamp: BigInt(now),
        expiresAt: BigInt(expiry),
        nonce,
        blockNumber,
        managerCode: '0x60006000',
        vaultCode: '0x60006000',
      })
      f.finalized.hash = blockHash
      f.canonical.hash = blockHash
      const result = await f.run()
      if (result.status !== 'verified') throw new Error('Invalid local snapshot fixture')
      return result.snapshot
    }
    const sync = async (nonce: bigint, revision: string, blockNumber = 90n, blockHash = h('90')) =>
      store.syncSnapshot({
        watchId,
        expectedRevision: revision,
        snapshot: await proof(nonce, blockNumber, blockHash),
      })
    const seedAttempt = async () => {
      const id = randomUUID(),
        op = receipt.target.operation
      await sql.begin(async (tx) => {
        await tx`INSERT INTO execution_attempts (id,authorization_id,job_id,chain_id,executor_address,purpose,state,transaction_hash)
          VALUES (${id},${auth.id},${job.id},56,${receipt.target.executor},'strategy','SUBMITTED',${receipt.target.transactionHash})`
        await tx`INSERT INTO strategy_operations
          (attempt_id,watch_id,watch_revision,expected_nonce,operation_digest,call_data_hash,envelope_hash,gas_limit_wei,operation,state)
          VALUES (${id},${watchId},1,7,${strategyOperationDigest(op)},${keccak256(encodeStrategyOperation(op))},${receipt.target.envelopeHash},100000000000,
            ${tx.json(JSON.parse(JSON.stringify(op, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))))},'PENDING')`
      })
      return id
    }
    const evidence = async (reverted = false) => {
      if (reverted) {
        receipt.receipt.status = 'reverted'
        receipt.receipt.logs = []
      }
      const result = await receipt.run()
      if (result.status !== 'verified') throw new Error('Invalid local receipt fixture')
      return result.receipt
    }
    const row = async () =>
      (
        await sql`SELECT checkpoint_nonce::text,snapshot_block::text,snapshot_hash,
      chain_snapshot,snapshot_timestamp,revision::text FROM strategy_watches WHERE id=${watchId}`
      )[0]
    return { watchId, sync, proof, seedAttempt, evidence, row }
  }

  it('rejects a smaller nonce even on a newer verified block', async () => {
    const f = await setup()
    expect((await f.sync(9n, '0')).status).toBe('applied')
    expect(await f.sync(8n, '1', 91n, h('91'))).toEqual({ status: 'not_ready' })
    expect((await f.row())?.checkpoint_nonce).toBe('9')
  })
  it('rejects a conflicting hash at the same height but permits an identical snapshot refresh', async () => {
    const f = await setup()
    await f.sync(7n, '0')
    expect(await f.sync(7n, '1', 90n, h('91'))).toEqual({ status: 'not_ready' })
    expect((await f.sync(7n, '1')).status).toBe('applied')
  })
  it.each([false, true])(
    'retains the receipt watermark after settlement, reverted=%s',
    async (reverted) => {
      const f = await setup()
      await f.sync(7n, '0')
      const id = await f.seedAttempt()
      expect(await store.settle(id, await f.evidence(reverted))).toBe('applied')
      expect(await f.row()).toMatchObject({
        checkpoint_nonce: reverted ? '7' : '8',
        snapshot_block: '100',
        snapshot_hash: h('77'),
        chain_snapshot: null,
        snapshot_timestamp: null,
        revision: '2',
      })
      expect(await f.sync(reverted ? 7n : 8n, '2', 99n, h('99'))).toEqual({ status: 'not_ready' })
      expect(await f.sync(reverted ? 7n : 8n, '2', 100n, h('ab'))).toEqual({ status: 'not_ready' })
      expect((await f.sync(reverted ? 7n : 8n, '2', 100n, h('77'))).status).toBe('applied')
      if (!reverted) expect(await f.sync(7n, '3', 101n, h('aa'))).toEqual({ status: 'not_ready' })
    },
  )
  it('does not let a replayed recent pre-execution proof roll back a settled nonce', async () => {
    const f = await setup(),
      old = await f.proof(7n)
    await store.syncSnapshot({ watchId: f.watchId, expectedRevision: '0', snapshot: old })
    const id = await f.seedAttempt()
    await store.settle(id, await f.evidence())
    expect(
      await store.syncSnapshot({ watchId: f.watchId, expectedRevision: '2', snapshot: old }),
    ).toEqual({ status: 'not_ready' })
    expect((await f.row())?.checkpoint_nonce).toBe('8')
  })
  it('preserves a higher existing watermark and nonce when settling an older transaction-local outcome', async () => {
    const f = await setup()
    await f.sync(9n, '0', 110n, h('aa'))
    const id = await f.seedAttempt()
    expect(await store.settle(id, await f.evidence())).toBe('applied')
    expect(await f.row()).toMatchObject({
      checkpoint_nonce: '9',
      snapshot_block: '110',
      snapshot_hash: h('aa'),
      chain_snapshot: null,
    })
  })
  it('does not unlock an attempt when the receipt conflicts with an existing same-height watermark', async () => {
    const f = await setup()
    await f.sync(7n, '0', 100n, h('aa'))
    const id = await f.seedAttempt()
    expect(await store.settle(id, await f.evidence())).toBe('changed')
    expect((await sql`SELECT state FROM execution_attempts WHERE id=${id}`)[0]?.state).toBe(
      'SUBMITTED',
    )
    expect(
      (await sql`SELECT state FROM strategy_operations WHERE attempt_id=${id}`)[0]?.state,
    ).toBe('PENDING')
  })
})
