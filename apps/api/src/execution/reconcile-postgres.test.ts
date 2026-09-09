import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { PostgresWatchStore } from '../runner/store.js'
import type { RecoveryEvidence, RecoveryReader } from './reconcile.js'
import { reconcileExecution } from './reconcile.js'
import { PostgresExecutionRecoveryStore } from './reconcile-store.js'

const databaseUrl = process.env.DATABASE_URL
const transactionHash = `0x${'ab'.repeat(32)}` as const
const blockHash = `0x${'cd'.repeat(32)}` as const
const proof: RecoveryEvidence = {
  chainId: 56,
  transactionHash,
  blockNumber: '80',
  blockHash,
  finalizedBlockNumber: '100',
  finalizedBlockHash: `0x${'ef'.repeat(32)}`,
}

describe.skipIf(!databaseUrl)('execution reconciliation against isolated PostgreSQL', () => {
  const schema = `execution_recovery_qa_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql
  let sql: postgres.Sql
  let other: postgres.Sql
  let jobsStore: PostgresJobStore
  let jobs: JobService
  let watches: PostgresWatchStore
  let recovery: PostgresExecutionRecoveryStore

  beforeAll(async () => {
    admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl as string)
    // Never fall back to public or share another suite's migration ledger.
    url.searchParams.set('search_path', schema)
    sql = postgres(url.toString(), { max: 2, onnotice: () => {} })
    other = postgres(url.toString(), { max: 1, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS schema`)[0]?.schema).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    jobsStore = new PostgresJobStore(url.toString())
    jobs = new JobService(jobsStore)
    watches = new PostgresWatchStore(url.toString())
    recovery = new PostgresExecutionRecoveryStore(sql)
  }, 30_000)

  afterAll(async () => {
    await Promise.all([jobsStore?.close(), watches?.close(), sql?.end(), other?.end()])
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })

  async function fixture() {
    const authorization = await jobs.authorize(
      [{ kind: 'session_total_cap', label: 'cap', value: '1000', tier: 'T2' }],
      `0x${'11'.repeat(20)}`,
    )
    const job = await jobs.createJob(authorization.id, randomUUID())
    const sender = `0x${randomUUID().replaceAll('-', '')}12345678`
    const claim = await jobs.beginExecution(job.id, 56, sender)
    await jobs.attempt(job.id, {
      target: '0x1',
      selector: '0x12',
      asset: '0x1',
      amount: 40n,
      at: new Date().toISOString(),
    })
    await jobs.recordExecutionHash(claim.attempt.id, transactionHash)
    await jobs.finishExecution(claim.attempt.id, 'UNCONFIRMED')
    await watches.create({
      jobId: job.id,
      authorizationId: authorization.id,
      account: '0x1',
      chainId: 56,
      protocol: 'venus',
      minimumHealthFactor: '1.25',
      asset: '0x1',
      market: '0x2',
      status: 'stopped',
      createdAt: new Date().toISOString(),
    })
    const attempt = await recovery.get(claim.attempt.id)
    if (!attempt) throw new Error('Missing fixture attempt')
    const target = { attemptId: attempt.id, chainId: 56 as const, transactionHash }
    const reader: RecoveryReader = {
      getChainId: async () => 56,
      getTransactionReceipt: async () => ({
        transactionHash,
        blockHash,
        blockNumber: 80n,
        status: 'success',
      }),
      getBlock: async (input) =>
        'blockTag' in input
          ? { number: 100n, hash: proof.finalizedBlockHash }
          : { number: 80n, hash: blockHash },
    }
    return { authorization, job, attempt, target, reader }
  }

  it('leaves attempts, counted spend, stopped watches and events unchanged in a dry run', async () => {
    const h = await fixture()
    const before = await jobs.getJob(h.job.id)
    expect(
      (await reconcileExecution({ target: h.target, store: recovery, reader: h.reader })).status,
    ).toBe('ready')
    expect(await recovery.get(h.attempt.id)).toEqual(h.attempt)
    expect((await jobs.getAuthorization(h.authorization.id)).spent).toBe(40n)
    expect((await watches.get(h.job.id))?.status).toBe('stopped')
    expect(await jobs.getJob(h.job.id)).toEqual(before)
  })

  it('finalizes once across concurrent connections without releasing any cap or restarting a watch', async () => {
    const h = await fixture()
    const second = new PostgresExecutionRecoveryStore(other)
    const outcomes = await Promise.all([
      recovery.finalizeSuccess(h.attempt, proof),
      second.finalizeSuccess(h.attempt, proof),
    ])
    expect(outcomes.sort()).toEqual(['already_finalized', 'applied'])
    expect((await recovery.get(h.attempt.id))?.state).toBe('LANDED')
    expect(await jobs.pendingExecution(h.authorization.id)).toBeNull()
    expect((await jobs.getAuthorization(h.authorization.id)).spent).toBe(40n)
    expect((await watches.get(h.job.id))?.status).toBe('stopped')
    const events = (await jobs.getJob(h.job.id)).events.filter((event) =>
      event.detail.includes('operator reconciliation'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.detail).toContain(blockHash)
    // A stale worker cannot subsequently refund a reconciled success.
    await jobs.finishExecution(h.attempt.id, 'REVERTED', 40n)
    expect((await jobs.getAuthorization(h.authorization.id)).spent).toBe(40n)
  })

  it('will not overwrite a worker transition that happened after inspection', async () => {
    const h = await fixture()
    await jobs.finishExecution(h.attempt.id, 'REVERTED', 40n)
    expect(await recovery.finalizeSuccess(h.attempt, proof)).toBe('changed')
    expect((await recovery.get(h.attempt.id))?.state).toBe('REVERTED')
    expect((await jobs.getAuthorization(h.authorization.id)).spent).toBe(0n)
    expect(
      (await jobs.getJob(h.job.id)).events.some((event) =>
        event.detail.includes('operator reconciliation'),
      ),
    ).toBe(false)
  })

  it('requires the exact database revision even if the attempt remains pending', async () => {
    const h = await fixture()
    await sql`UPDATE execution_attempts SET updated_at = updated_at + interval '1 second' WHERE id = ${h.attempt.id}`
    expect(await recovery.finalizeSuccess(h.attempt, proof)).toBe('changed')
    expect((await recovery.get(h.attempt.id))?.state).toBe('UNCONFIRMED')
    expect((await jobs.getAuthorization(h.authorization.id)).spent).toBe(40n)
  })

  it('does not unlock or refund a finalized revert without durable reservation evidence', async () => {
    const h = await fixture()
    h.reader.getTransactionReceipt = async () => ({
      transactionHash,
      blockHash,
      blockNumber: 80n,
      status: 'reverted',
    })
    expect(
      (
        await reconcileExecution({
          target: h.target,
          apply: true,
          store: recovery,
          reader: h.reader,
        })
      ).status,
    ).toBe('blocked')
    expect(await recovery.get(h.attempt.id)).toEqual(h.attempt)
    expect((await jobs.getAuthorization(h.authorization.id)).spent).toBe(40n)
    expect((await jobs.beginExecution(h.job.id, 56)).acquired).toBe(false)
  })

  it('atomically rolls back finalization if the audit event cannot be recorded', async () => {
    const h = await fixture()
    await sql`ALTER TABLE job_events ADD CONSTRAINT reject_recovery_audit CHECK (detail NOT LIKE '%operator reconciliation%') NOT VALID`
    try {
      await expect(recovery.finalizeSuccess(h.attempt, proof)).rejects.toThrow()
      expect(await recovery.get(h.attempt.id)).toEqual(h.attempt)
      expect((await jobs.getAuthorization(h.authorization.id)).spent).toBe(40n)
    } finally {
      await sql`ALTER TABLE job_events DROP CONSTRAINT reject_recovery_audit`
    }
  })
})
