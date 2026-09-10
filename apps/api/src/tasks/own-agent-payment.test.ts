import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ESCROW_ACCOUNT, PostgresCreditStore } from '../credits/store.js'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { JobService } from '../jobs/service.js'
import { InMemoryJobStore } from '../jobs/store.js'
import { registerTaskRoutes } from './routes.js'
import { PostgresTaskStore } from './store.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw Error('Own-agent payment regressions require an isolated loopback database.')

describe.skipIf(!databaseUrl)('own-agent task payment preserves existing escrow semantics', () => {
  const schema = `own_agent_payment_${randomUUID().replaceAll('-', '')}`
  const agentId = 'local-owned-agent'
  let admin: postgres.Sql, sql: postgres.Sql, tasks: PostgresTaskStore, credits: PostgresCreditStore
  let scopedUrl: string

  beforeAll(async () => {
    if (!databaseUrl) throw Error('Missing isolated test database')
    admin = postgres(databaseUrl, {
      max: 1,
      onnotice: () => {},
      connect_timeout: 5,
      connection: { statement_timeout: 10_000 },
    })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl)
    url.searchParams.set('search_path', schema)
    scopedUrl = url.toString()
    sql = postgres(scopedUrl, { max: 2, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    tasks = new PostgresTaskStore(scopedUrl)
    credits = new PostgresCreditStore(scopedUrl)
  }, 30_000)

  afterAll(async () => {
    await Promise.all([tasks?.close(), credits?.close(), sql?.end({ timeout: 5 })])
    if (admin) {
      try {
        await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      } finally {
        await admin.end({ timeout: 5 })
      }
    }
  })

  const wallet = () => `0x${randomUUID().replaceAll('-', '')}12345678`
  async function fixture(options: { sameTreasury?: boolean; funded?: boolean } = {}) {
    const payer = wallet(),
      treasury = options.sameTreasury ? payer : wallet()
    await credits.deposit({
      owner: payer,
      points: 1000,
      reason: 'test',
      reference: randomUUID(),
    })
    // Use the actual direct-agent creation and delivery paths: unlike hiring a
    // person or claiming open work, this path has always allowed an owned agent.
    const task = await tasks.create({
      poster: payer,
      title: 'Review my own agent report',
      brief: 'Local fixture; no provider or chain request.',
      kind: 'verify',
      pricePoints: 40,
      feePoints: 1,
      totalPoints: 41,
      outlay: 41n,
      workHours: 24,
      assigned: { agentId, owner: payer },
    })
    expect(task).toMatchObject({
      status: 'CLAIMED',
      directHire: true,
      poster: payer,
      claimedBy: payer,
      assignedAgentId: agentId,
    })
    if (options.funded !== false)
      await credits.transfer({
        from: payer,
        to: ESCROW_ACCOUNT,
        points: 41,
        reason: 'task_funding',
        reference: `task:${task.id}:funding`,
        detail: { taskId: task.id },
      })
    expect(
      await tasks.recordDelivery(task.id, agentId, 'The local report was delivered.'),
    ).toMatchObject({ status: 'SUBMITTED' })
    const entries = () =>
      sql<
        {
          owner: string
          delta: string
          reason: string
          reference: string
          detail: Record<string, unknown>
        }[]
      >`
        SELECT owner,delta::text,reason,reference,detail FROM credit_entries
        WHERE reference LIKE ${`task:${task.id}:%`} ORDER BY reference
      `
    const state = async () => ({
      task: await tasks.get(task.id),
      payer: await credits.balance(payer),
      treasury: await credits.balance(treasury),
      escrow: await credits.balance(ESCROW_ACCOUNT),
      entries: await entries(),
    })
    const settle = (store = tasks) =>
      store.finalizePayment({ taskId: task.id, actor: payer, action: 'accept', treasury })
    return { task, payer, treasury, entries, state, settle }
  }

  for (const sameTreasury of [false, true]) {
    it(`settles payer=provider${sameTreasury ? '=treasury' : ' with a separate treasury'} through the real accept route, then replays once`, async () => {
      const f = await fixture({ sameTreasury })
      const before = await f.state()
      const app = Fastify()
      app.addHook('onRequest', async (request) => {
        request.session = {
          address: f.payer,
          chainId: 56,
          exp: Math.floor(Date.now() / 1000) + 600,
        }
      })
      registerTaskRoutes(app, {
        tasks,
        credits,
        jobs: new JobService(new InMemoryJobStore()),
        settlementTreasury: f.treasury,
      })
      try {
        const response = await app.inject({ method: 'POST', url: `/v1/tasks/${f.task.id}/accept` })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ status: 'SETTLED', alreadyFinalized: false })
        const after = await f.state()
        expect(after.payer).toBe(sameTreasury ? 1000 : 999)
        expect(after.treasury).toBe(sameTreasury ? 1000 : 1)
        expect(after.escrow).toBe(before.escrow - 41)
        expect(after.entries).toHaveLength(6)
        expect(after.entries.filter((entry) => entry.reason === 'task_funding')).toEqual(
          before.entries,
        )
        expect(after.entries.reduce((sum, entry) => sum + BigInt(entry.delta), 0n)).toBe(0n)
        expect(after.entries.filter((entry) => entry.reason !== 'task_funding')).toHaveLength(4)
        for (const entry of after.entries.filter((entry) => entry.reason !== 'task_funding'))
          expect(entry.detail).toMatchObject({
            taskId: f.task.id,
            atomicTaskFinalization: 1,
            finalization: 'settlement',
          })
        const replay = await app.inject({ method: 'POST', url: `/v1/tasks/${f.task.id}/accept` })
        expect(replay.statusCode).toBe(200)
        expect(replay.json()).toMatchObject({ alreadyFinalized: true })
        expect(await f.state()).toEqual(after)
      } finally {
        await app.close()
      }
    })
  }

  it('aggregates the shared wallet exactly once across independent store instances', async () => {
    const f = await fixture({ sameTreasury: true })
    const another = new PostgresTaskStore(scopedUrl)
    try {
      const result = await Promise.all([
        f.settle(),
        f.settle(another),
        f.settle(),
        f.settle(another),
      ])
      expect(result.filter((entry) => entry?.alreadyFinalized === false)).toHaveLength(1)
      expect(result.filter((entry) => entry?.alreadyFinalized === true)).toHaveLength(3)
      expect(await credits.balance(f.payer)).toBe(1000)
      expect(await f.entries()).toHaveLength(6)
      const before = await f.state()
      expect(await f.settle(another)).toMatchObject({ alreadyFinalized: true })
      expect(await f.state()).toEqual(before)
    } finally {
      await another.close()
    }
  })

  it('still requires this task’s original funding, not another task’s escrow', async () => {
    await fixture()
    const f = await fixture({ funded: false })
    const before = await f.state()
    await expect(f.settle()).rejects.toThrow('funding could not be verified')
    expect(await f.state()).toEqual(before)
  })

  it('still refuses another actor and refuses cancellation of delivered work', async () => {
    const f = await fixture()
    const before = await f.state()
    expect(
      await tasks.finalizePayment({
        taskId: f.task.id,
        actor: wallet(),
        action: 'accept',
        treasury: f.treasury,
      }),
    ).toBeNull()
    expect(
      await tasks.finalizePayment({ taskId: f.task.id, actor: f.payer, action: 'cancel' }),
    ).toBeNull()
    expect(await f.state()).toEqual(before)
  })
})
