import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { PostgresExecutionRecoveryStore } from './reconcile-store.js'

const databaseUrl = process.env.DATABASE_URL
const hash = `0x${'ab'.repeat(32)}` as const
const sender = () => `0x${randomUUID().replaceAll('-', '')}12345678`

describe.skipIf(!databaseUrl)('durable shared-signer claims in isolated PostgreSQL', () => {
  const schema = `execution_signer_qa_${randomUUID().replaceAll('-', '')}`
  const stores: PostgresJobStore[] = []
  let admin: postgres.Sql
  let sql: postgres.Sql
  let scopedUrl: string
  const service = () => {
    const store = new PostgresJobStore(scopedUrl)
    stores.push(store)
    return new JobService(store)
  }

  beforeAll(async () => {
    admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl as string)
    url.searchParams.set('search_path', schema)
    scopedUrl = url.toString()
    sql = postgres(scopedUrl, { max: 2, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS schema`)[0]?.schema).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
  }, 30_000)

  afterAll(async () => {
    await Promise.all([...stores.map((store) => store.close()), sql?.end()])
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })

  async function job(jobs = service()) {
    const auth = await jobs.authorize(
      [{ kind: 'session_total_cap', label: 'cap', value: '100', tier: 'T2' }],
      `0x${'11'.repeat(20)}`,
    )
    return { jobs, auth, job: await jobs.createJob(auth.id, randomUUID()) }
  }

  it('allows exactly one same-chain signer claim across independent connection pools and mandates', async () => {
    const h = await job()
    const other = await job()
    const signer = sender()
    const results = await Promise.all([
      h.jobs.beginExecution(h.job.id, 56, signer),
      other.jobs.beginExecution(other.job.id, 56, signer.toUpperCase().replace('0X', '0x')),
    ])
    expect(results.filter((result) => result.acquired)).toHaveLength(1)
    expect(results.find((result) => !result.acquired)?.scope).toBe('executor')
    expect(results[0]?.attempt.id).toBe(results[1]?.attempt.id)
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM execution_attempts WHERE executor_address = ${signer}`
      )[0]?.count,
    ).toBe(1)
  })

  it('keeps the prepared hash and signer lock after uncertainty and a connection restart', async () => {
    const h = await job()
    const signer = sender()
    const claim = await h.jobs.beginExecution(h.job.id, 56, signer)
    await h.jobs.recordExecutionHash(claim.attempt.id, hash)
    await h.jobs.finishExecution(claim.attempt.id, 'UNCONFIRMED')
    const other = await job(service())
    expect(await other.jobs.beginExecution(other.job.id, 56, signer)).toMatchObject({
      acquired: false,
      scope: 'executor',
      attempt: { id: claim.attempt.id, transactionHash: hash, executorAddress: signer },
    })
    expect((await other.jobs.getAuthorization(other.auth.id)).spent).toBe(0n)
  })

  it('does not serialize different signers on one chain or the same signer on another chain', async () => {
    const a = await job()
    const b = await job()
    const c = await job()
    const signer = sender()
    expect((await a.jobs.beginExecution(a.job.id, 56, signer)).acquired).toBe(true)
    expect((await b.jobs.beginExecution(b.job.id, 56, sender())).acquired).toBe(true)
    const independent = await c.jobs.beginExecution(c.job.id, 97, signer)
    expect(independent.acquired).toBe(true)
    await c.jobs.finishExecution(independent.attempt.id, 'REFUSED')
  })

  it.each(['REFUSED', 'REVERTED', 'LANDED'] as const)(
    'allows another mandate only after terminal %s',
    async (state) => {
      const h = await job()
      const other = await job()
      const signer = sender()
      const claim = await h.jobs.beginExecution(h.job.id, 56, signer)
      expect((await other.jobs.beginExecution(other.job.id, 56, signer)).acquired).toBe(false)
      await h.jobs.finishExecution(claim.attempt.id, state)
      expect((await other.jobs.beginExecution(other.job.id, 56, signer)).acquired).toBe(true)
    },
  )

  it('lets verified operator success release only its signer lock without releasing counted spend', async () => {
    const h = await job()
    const other = await job()
    const signer = sender()
    const claim = await h.jobs.beginExecution(h.job.id, 56, signer)
    await h.jobs.attempt(h.job.id, {
      target: '0x1',
      asset: '0x1',
      selector: '0x12',
      amount: 40n,
      at: new Date().toISOString(),
    })
    await h.jobs.recordExecutionHash(claim.attempt.id, hash)
    await h.jobs.finishExecution(claim.attempt.id, 'UNCONFIRMED')
    const recovery = new PostgresExecutionRecoveryStore(sql)
    const attempt = await recovery.get(claim.attempt.id)
    if (!attempt) throw new Error('Missing fixture attempt')
    expect(
      await recovery.finalizeSuccess(attempt, {
        chainId: 56,
        transactionHash: hash,
        blockNumber: '80',
        blockHash: hash,
        finalizedBlockNumber: '100',
        finalizedBlockHash: hash,
      }),
    ).toBe('applied')
    expect((await other.jobs.beginExecution(other.job.id, 56, signer)).acquired).toBe(true)
    expect((await h.jobs.getAuthorization(h.auth.id)).spent).toBe(40n)
  })

  it('fences legacy unknown senders across connections, without rewriting historical rows', async () => {
    const h = await job()
    const other = await job()
    // No other chain-97 claim survives this suite. The unknown sender models
    // a migration-028 row: its identity cannot safely be inferred or backfilled.
    const claim = await h.jobs.beginExecution(h.job.id, 97)
    expect(claim.acquired).toBe(true)
    expect(await other.jobs.beginExecution(other.job.id, 97, sender())).toMatchObject({
      acquired: false,
      scope: 'executor',
      attempt: { id: claim.attempt.id },
    })
    expect(
      (await sql`SELECT executor_address FROM execution_attempts WHERE id = ${claim.attempt.id}`)[0]
        ?.executor_address,
    ).toBeNull()
    // Finishing this known pre-broadcast fixture is only test cleanup. The
    // operator recovery command never clears legacy PREPARING rows this way.
    await h.jobs.finishExecution(claim.attempt.id, 'REFUSED')
  })

  it('does not allow an unknown-sender caller to bypass a known-sender pending row', async () => {
    const h = await job()
    const other = await job()
    const claim = await h.jobs.beginExecution(h.job.id, 97, sender())
    expect((await other.jobs.beginExecution(other.job.id, 97)).acquired).toBe(false)
    await h.jobs.finishExecution(claim.attempt.id, 'REFUSED')
  })

  it('uses a database unique constraint even if a sender-aware writer skips the claim helper', async () => {
    const h = await job()
    const other = await job()
    const signer = sender()
    await h.jobs.beginExecution(h.job.id, 56, signer)
    await expect(
      sql`INSERT INTO execution_attempts (id, authorization_id, job_id, chain_id, executor_address, state) VALUES (${randomUUID()}, ${other.auth.id}, ${other.job.id}, 56, ${signer}, 'PREPARING')`,
    ).rejects.toMatchObject({ code: '23505' })
  })
})
