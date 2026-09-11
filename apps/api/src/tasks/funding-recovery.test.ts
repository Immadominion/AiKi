import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { settlementForPoints } from '../credits/pricing.js'
import { ESCROW_ACCOUNT, PostgresCreditStore } from '../credits/store.js'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { SETTLEMENT } from '../settlement/pricing.js'
import { registerTaskRoutes } from './routes.js'
import { PostgresTaskStore } from './store.js'

const fetched = vi.fn(async (..._args: unknown[]) => {
  throw new Error('Recovery must not call a provider')
})
vi.mock('../net/guard.js', () => ({ guardedFetch: (...args: unknown[]) => fetched(...args) }))

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Task funding recovery requires an isolated loopback database.')

describe.skipIf(!databaseUrl)('read-only task funding recovery over HTTP', () => {
  const schema = `task_funding_recovery_${randomUUID().replaceAll('-', '')}`
  const cleanup: Array<() => Promise<unknown>> = []
  let admin: postgres.Sql, sql: postgres.Sql, scopedUrl: string
  let tasks: PostgresTaskStore, credits: PostgresCreditStore, jobStore: PostgresJobStore
  let jobs: JobService
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Missing test database')
    admin = postgres(databaseUrl, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl)
    url.searchParams.set('search_path', schema)
    scopedUrl = url.toString()
    sql = postgres(scopedUrl, { max: 5, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    tasks = new PostgresTaskStore(scopedUrl)
    credits = new PostgresCreditStore(scopedUrl)
    jobStore = new PostgresJobStore(scopedUrl)
    jobs = new JobService(jobStore)
  }, 30_000)
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
    vi.restoreAllMocks()
    fetched.mockClear()
  })
  afterAll(async () => {
    await Promise.all([tasks?.close(), credits?.close(), jobStore?.close()])
    await sql?.end()
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })

  const wallet = () => `0x${randomUUID().replaceAll('-', '')}12345678`
  async function fixture(options: { commit?: boolean; direct?: boolean } = {}) {
    const owner = wallet(),
      seller = wallet(),
      treasury = wallet(),
      key = randomUUID()
    const contact = vi.fn(async () => ({
      owner: seller,
      endpoint: 'https://never-called.example/task',
      live: true,
      compatible: true,
    }))
    const authorization = await jobs.authorize(
      [
        { kind: 'asset_scope', value: [SETTLEMENT.address], tier: 'T2', label: 'Asset' },
        {
          kind: 'session_total_cap',
          value: settlementForPoints(1000, SETTLEMENT.decimals).toString(),
          tier: 'T2',
          label: 'Cap',
        },
      ],
      owner,
    )
    await credits.deposit({ owner, points: 600, reason: 'test', reference: randomUUID() })
    const payload = {
      title: 'Read a position',
      brief: 'No transactions or paid provider calls.',
      kind: 'research',
      pricePoints: 500,
      workHours: 1,
      authorizationId: authorization.id,
      ...(options.direct === false ? {} : { assignAgentId: '315943' }),
    }
    const build = (actor: string | null = owner, restarted = false) => {
      const localTasks = restarted ? new PostgresTaskStore(scopedUrl) : tasks
      const localCredits = restarted ? new PostgresCreditStore(scopedUrl) : credits
      if (restarted)
        cleanup.push(
          () => localTasks.close(),
          () => localCredits.close(),
        )
      const app = Fastify()
      app.addHook('onRequest', async (request) => {
        if (actor)
          request.session = {
            address: actor,
            chainId: 56,
            exp: Math.floor(Date.now() / 1000) + 600,
          }
      })
      registerTaskRoutes(app, {
        tasks: localTasks,
        credits: localCredits,
        jobs,
        settlementTreasury: treasury,
        agentContact: contact,
        publicUrl: 'https://api.example',
        deliverySecret: 'test-only',
      })
      cleanup.push(() => app.close())
      return {
        app,
        request: (body = payload, requestKey = key) =>
          app.inject({
            method: 'POST',
            url: '/v1/tasks',
            headers: { 'idempotency-key': requestKey },
            payload: body,
          }),
      }
    }
    const h = build()
    const transfer = credits.transfer.bind(credits)
    const charged = vi.spyOn(credits, 'transfer').mockImplementationOnce(async (input) => {
      if (options.commit !== false) await transfer(input)
      throw new Error('Lost commit acknowledgement')
    })
    vi.spyOn(credits, 'transferRecorded').mockRejectedValueOnce(new Error('Read unavailable'))
    const first = await h.request()
    expect(first.statusCode).toBe(503)
    expect(first.json().error.code).toBe('TASK_FUNDING_UNCONFIRMED')
    const task = await tasks.get(first.json().error.taskId)
    if (!task) throw new Error('Missing original task')
    const state = async () => ({
      task: await tasks.get(task.id),
      balance: await credits.balance(owner),
      escrow: await credits.balance(ESCROW_ACCOUNT),
      authorization: await jobs.getAuthorization(authorization.id),
      entries:
        await sql`SELECT owner, delta::text, reason, reference, detail FROM credit_entries WHERE reference LIKE ${`task:${task.id}:%`} ORDER BY reference`,
      requests:
        await sql`SELECT * FROM idempotency_records WHERE actor_id IN (SELECT id FROM actors WHERE controller_address = ${owner}) ORDER BY id`,
    })
    return {
      ...h,
      build,
      owner,
      seller,
      treasury,
      authorization,
      payload,
      key,
      task,
      first,
      state,
      charged,
      contact,
    }
  }

  it('recovers the exact original funded task after restart without another charge, cap or dispatch', async () => {
    const h = await fixture(),
      before = await h.state()
    expect(before.balance).toBe(88)
    expect(before.authorization.spent).toBe(settlementForPoints(512, SETTLEMENT.decimals))
    const replay = await h.build(h.owner.toUpperCase().replace('0X', '0x'), true).request()
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json()).toMatchObject({
      ...h.task,
      outlay: h.task.outlay.toString(),
      originalFundingConfirmed: true,
      heldPoints: 512,
      workUrl: `/work?task=${h.task.id}`,
    })
    expect(replay.json().recoveryNote).toContain('No new work was sent by this retry')
    expect(replay.json().recoveryNote).toContain('claim deadline')
    expect(replay.json().dispatchedAt).toBeUndefined()
    expect(replay.json().refundedPoints).toBeUndefined()
    expect(await h.state()).toEqual(before)
    expect(h.charged).toHaveBeenCalledTimes(1)
    expect(h.contact).toHaveBeenCalledTimes(1)
    expect(fetched).not.toHaveBeenCalled()
  })

  it('allows concurrent readback retries without changing any task, funding, allowance or saved response', async () => {
    const h = await fixture(),
      before = await h.state()
    const results = await Promise.all([h.request(), h.build(h.owner, true).request(), h.request()])
    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 200])
    expect(results.every((result) => result.json().id === h.task.id)).toBe(true)
    expect(await h.state()).toEqual(before)
    expect(h.charged).toHaveBeenCalledTimes(1)
    expect(fetched).not.toHaveBeenCalled()
  })

  it.each(['revoked', 'expired'] as const)(
    'does not require a new allowance or live registry lookup to read back a %s mandate',
    async (status) => {
      const h = await fixture()
      if (status === 'revoked') await jobs.revoke(h.authorization.id)
      else
        await sql`UPDATE authorizations SET expires_at = now() - interval '1 second' WHERE id = ${h.authorization.id}`
      h.contact.mockRejectedValue(new Error('Registry unavailable'))
      const before = await h.state()
      expect((await h.request()).statusCode).toBe(200)
      expect(await h.state()).toEqual(before)
      expect(h.contact).toHaveBeenCalledTimes(1)
      expect(fetched).not.toHaveBeenCalled()
    },
  )

  it('keeps a permanent ledger or task read failure unconfirmed without dispatch or new funding', async () => {
    const h = await fixture(),
      before = await h.state()
    const lookup = vi.spyOn(credits, 'transferRecorded').mockRejectedValue(new Error('Unavailable'))
    expect((await h.request()).json()).toEqual(h.first.json())
    lookup.mockRestore()
    const read = vi.spyOn(tasks, 'get').mockRejectedValueOnce(new Error('Task read unavailable'))
    expect((await h.request()).json()).toEqual(h.first.json())
    read.mockRestore()
    expect(await h.state()).toEqual(before)
    expect(h.charged).toHaveBeenCalledTimes(1)
    expect(fetched).not.toHaveBeenCalled()
  })

  it.each(['missing', 'partial', 'wrong-owner', 'wrong-amount'] as const)(
    'does not treat %s funding or pooled escrow as proof',
    async (shape) => {
      const h = await fixture({ commit: false })
      await credits.deposit({
        owner: ESCROW_ACCOUNT,
        points: 10000,
        reason: 'test',
        reference: randomUUID(),
      })
      if (shape !== 'missing') {
        const payer = shape === 'wrong-owner' ? wallet() : h.owner
        await credits.deposit({
          owner: payer,
          points: 600,
          reason: 'test',
          reference: randomUUID(),
        })
        await credits.transfer({
          from: payer,
          to: ESCROW_ACCOUNT,
          points: shape === 'wrong-amount' ? 511 : 512,
          reason: 'task_funding',
          reference: `task:${h.task.id}:funding`,
        })
        if (shape === 'partial')
          await sql`DELETE FROM credit_entries WHERE reference = ${`task:${h.task.id}:funding:in`}`
      }
      const before = await h.state(),
        response = await h.request()
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual(h.first.json())
      expect(await h.state()).toEqual(before)
      expect(fetched).not.toHaveBeenCalled()
    },
  )

  it('retains authentication, owner scoping and same-key payload conflicts', async () => {
    const h = await fixture(),
      before = await h.state()
    expect((await h.build(null).request()).statusCode).toBe(401)
    const other = await h.build(wallet()).request()
    expect(other.statusCode).toBe(403)
    expect(other.json().error.taskId).toBeUndefined()
    for (const changedBody of [
      { ...h.payload, pricePoints: 501 },
      { ...h.payload, assignAgentId: 'another-agent' },
    ]) {
      const changed = await h.request(changedBody)
      expect(changed.statusCode).toBe(409)
      expect(changed.json().error.code).toBe('TASK_IDEMPOTENCY_CONFLICT')
    }
    expect(await h.state()).toEqual(before)
    expect(h.charged).toHaveBeenCalledTimes(1)
    expect(fetched).not.toHaveBeenCalled()
  })

  it.each(['SUBMITTED', 'SETTLED', 'CANCELLED', 'DISPUTED'] as const)(
    'returns current %s state without implying another dispatch, payment or refund',
    async (status) => {
      const h = await fixture()
      if (status === 'CANCELLED') {
        await sql`UPDATE tasks SET claim_expires_at = now() - interval '1 second' WHERE id = ${h.task.id}`
        expect(
          await tasks.finalizePayment({ taskId: h.task.id, actor: h.owner, action: 'cancel' }),
        ).not.toBeNull()
      } else {
        await tasks.noteDispatch(h.task.id, 'Original delivery recorded elsewhere')
        expect(await tasks.recordDelivery(h.task.id, '315943', 'Original report')).not.toBeNull()
        if (status === 'SETTLED')
          expect(
            await tasks.finalizePayment({
              taskId: h.task.id,
              actor: h.owner,
              action: 'accept',
              treasury: h.treasury,
            }),
          ).not.toBeNull()
        if (status === 'DISPUTED')
          expect(await tasks.advance(h.task.id, ['SUBMITTED'], 'DISPUTED')).not.toBeNull()
      }
      const before = await h.state(),
        response = await h.request()
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        id: h.task.id,
        status,
        originalFundingConfirmed: true,
        heldPoints: ['SUBMITTED', 'DISPUTED'].includes(status) ? 512 : 0,
      })
      expect(response.json().refundedPoints).toBeUndefined()
      expect(response.json().paidPoints).toBeUndefined()
      expect(response.json().recoveryNote).toContain(status)
      expect(await h.state()).toEqual(before)
      expect(h.charged).toHaveBeenCalledTimes(1)
      expect(fetched).not.toHaveBeenCalled()
    },
  )

  it('returns open work without inventing an agent claim or moving the cancellation deadline', async () => {
    const h = await fixture({ direct: false }),
      before = await h.state()
    const response = await h.request()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: h.task.id, status: 'OPEN', heldPoints: 512 })
    expect(response.json().recoveryNote).toContain('cancel unclaimed work')
    expect(response.json().claimExpiresAt).toBeUndefined()
    expect(await h.state()).toEqual(before)
    expect(fetched).not.toHaveBeenCalled()
  })

  it('rejects malformed, missing or another owner’s stored task reference without changing the response', async () => {
    const h = await fixture(),
      other = await fixture()
    for (const taskId of ['invalid-id', randomUUID(), other.task.id]) {
      const body = { error: { ...h.first.json().error, taskId } }
      vi.spyOn(tasks, 'beginCreateRequest').mockResolvedValueOnce({
        kind: 'replayed',
        statusCode: 503,
        body,
      })
      const response = await h.request()
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual(body)
    }
    expect(fetched).not.toHaveBeenCalled()
  })

  it('does not turn other failures or an in-progress original request into a new attempt', async () => {
    const h = await fixture(),
      before = await h.state()
    for (const code of ['TASK_REFUND_UNCONFIRMED', 'INTERNAL_ERROR']) {
      const body = { error: { ...h.first.json().error, code } }
      vi.spyOn(tasks, 'beginCreateRequest').mockResolvedValueOnce({
        kind: 'replayed',
        statusCode: 503,
        body,
      })
      expect((await h.request()).json()).toEqual(body)
    }
    vi.spyOn(tasks, 'beginCreateRequest').mockResolvedValueOnce({ kind: 'in_progress' })
    expect((await h.request()).json().error.code).toBe('TASK_REQUEST_IN_PROGRESS')
    expect(await h.state()).toEqual(before)
    expect(h.charged).toHaveBeenCalledTimes(1)
    expect(fetched).not.toHaveBeenCalled()
  })
})
