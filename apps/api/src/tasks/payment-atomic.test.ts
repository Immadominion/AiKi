import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ESCROW_ACCOUNT, PostgresCreditStore } from '../credits/store.js'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { registerTaskRoutes } from './routes.js'
import { PostgresTaskStore } from './store.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Task payment regressions require an isolated loopback database.')

describe.skipIf(!databaseUrl)('atomic task payment finalization in isolated PostgreSQL', () => {
  const schema = `task_payment_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql, sql: postgres.Sql, tasks: PostgresTaskStore, credits: PostgresCreditStore
  let jobStore: PostgresJobStore, jobs: JobService, scopedUrl: string
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
  afterAll(async () => {
    await Promise.all([tasks?.close(), credits?.close(), jobStore?.close()])
    await sql?.end()
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })

  const wallet = () => `0x${randomUUID().replaceAll('-', '')}12345678`
  async function fixture(options: { fee?: number; mandate?: boolean; funded?: boolean } = {}) {
    const payer = wallet(),
      payee = wallet(),
      treasury = wallet(),
      price = 100,
      fee = options.fee ?? 2
    const auth = options.mandate
      ? await jobs.authorize(
          [
            {
              kind: 'session_total_cap',
              value: '1000',
              tier: 'T2',
              label: 'Local reservation limit',
            },
          ],
          payer,
        )
      : null
    if (auth) await sql`UPDATE authorizations SET spent = 500 WHERE id = ${auth.id}`
    await credits.deposit({ owner: payer, points: 1000, reason: 'test', reference: randomUUID() })
    const task = await tasks.create({
      poster: payer,
      ...(auth ? { authorizationId: auth.id } : {}),
      title: 'Verify a local report',
      brief: 'No provider call.',
      kind: 'verify',
      pricePoints: price,
      feePoints: fee,
      totalPoints: price + fee,
      outlay: 200n,
      workHours: 24,
    })
    if (options.funded !== false)
      await credits.transfer({
        from: payer,
        to: ESCROW_ACCOUNT,
        points: price + fee,
        reason: 'task_funding',
        reference: `task:${task.id}:funding`,
        detail: { taskId: task.id },
      })
    const submit = async () => {
      expect(await tasks.claim(task.id, payee)).not.toBeNull()
      expect(await tasks.submit(task.id, payee, 'The report was delivered.')).not.toBeNull()
    }
    const entries = () =>
      sql`SELECT owner, delta::text, reason, reference, detail FROM credit_entries WHERE detail->>'taskId' = ${task.id} ORDER BY reference`
    const settle = (action: 'accept' | 'release' = 'accept') =>
      tasks.finalizePayment({
        taskId: task.id,
        actor: action === 'accept' ? payer : payee,
        action,
        treasury,
      })
    const cancel = () => tasks.finalizePayment({ taskId: task.id, actor: payer, action: 'cancel' })
    const state = async () => ({
      task: await tasks.get(task.id),
      payer: await credits.balance(payer),
      payee: await credits.balance(payee),
      treasury: await credits.balance(treasury),
      escrow: await credits.balance(ESCROW_ACCOUNT),
      entries: await entries(),
      spent: auth
        ? (await sql`SELECT spent::text FROM authorizations WHERE id = ${auth.id}`)[0]?.spent
        : null,
    })
    return { task, payer, payee, treasury, auth, submit, entries, settle, cancel, state }
  }

  it('atomically settles the frozen seller and fee amounts and safely repeats after restart', async () => {
    const f = await fixture()
    await f.submit()
    const before = await credits.balance(ESCROW_ACCOUNT)
    expect(await f.settle()).toMatchObject({ task: { status: 'SETTLED' }, alreadyFinalized: false })
    expect(await credits.balance(f.payer)).toBe(898)
    expect(await credits.balance(f.payee)).toBe(100)
    expect(await credits.balance(f.treasury)).toBe(2)
    expect(await credits.balance(ESCROW_ACCOUNT)).toBe(before - 102)
    const snapshot = await f.state(),
      restarted = new PostgresTaskStore(scopedUrl)
    try {
      expect(
        await restarted.finalizePayment({
          taskId: f.task.id,
          actor: f.payer,
          action: 'accept',
          treasury: f.treasury,
        }),
      ).toMatchObject({ alreadyFinalized: true })
    } finally {
      await restarted.close()
    }
    expect(await f.state()).toEqual(snapshot)
    expect((await f.entries()).reduce((sum, entry) => sum + BigInt(entry.delta), 0n)).toBe(0n)
  })

  it('rolls back seller payout, balances and state if writing the fee fails', async () => {
    const f = await fixture()
    await f.submit()
    const before = await f.state()
    await sql.unsafe(
      `CREATE FUNCTION fail_task_fee() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.detail->>'taskId' = '${f.task.id}' AND NEW.reason = 'platform_fee' THEN RAISE EXCEPTION 'injected fee failure'; END IF; RETURN NEW; END $$`,
    )
    await sql`CREATE TRIGGER fail_task_fee BEFORE INSERT ON credit_entries FOR EACH ROW EXECUTE FUNCTION fail_task_fee()`
    try {
      await expect(f.settle()).rejects.toThrow('injected fee failure')
    } finally {
      await sql`DROP TRIGGER fail_task_fee ON credit_entries`
      await sql`DROP FUNCTION fail_task_fee()`
    }
    expect(await f.state()).toEqual(before)
    expect(await f.settle()).toMatchObject({ task: { status: 'SETTLED' }, alreadyFinalized: false })
  })

  it('refunds exact funding and allowance once and permits a harmless cancelled readback', async () => {
    const f = await fixture({ mandate: true })
    expect(await f.cancel()).toMatchObject({
      task: { status: 'CANCELLED' },
      alreadyFinalized: false,
    })
    expect((await f.state()).spent).toBe('300')
    expect(await credits.balance(f.payer)).toBe(1000)
    const before = await f.state()
    expect(await f.cancel()).toMatchObject({ alreadyFinalized: true })
    expect(await f.cancel()).toMatchObject({ alreadyFinalized: true })
    expect(await f.state()).toEqual(before)
  })

  it('rolls the entire cancellation back when its exact allowance cannot be returned', async () => {
    const f = await fixture({ mandate: true })
    if (!f.auth) throw Error('Missing mandate')
    await sql`UPDATE authorizations SET spent = 199 WHERE id = ${f.auth.id}`
    const before = await f.state()
    await expect(f.cancel()).rejects.toThrow('reservation')
    expect(await f.state()).toEqual(before)
    await sql`UPDATE authorizations SET spent = 500 WHERE id = ${f.auth.id}`
    expect(await f.cancel()).toMatchObject({ alreadyFinalized: false })
  })

  it.each(['accept', 'cancel'] as const)(
    'rolls back every %s movement if the final task-state write fails',
    async (action) => {
      const f = await fixture({ mandate: action === 'cancel' })
      if (action === 'accept') await f.submit()
      const before = await f.state()
      await sql.unsafe(
        `CREATE FUNCTION fail_task_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${f.task.id}' AND NEW.status IN ('SETTLED','CANCELLED') THEN RAISE EXCEPTION 'injected terminal failure'; END IF; RETURN NEW; END $$`,
      )
      await sql`CREATE TRIGGER fail_task_terminal BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION fail_task_terminal()`
      try {
        await expect(action === 'accept' ? f.settle() : f.cancel()).rejects.toThrow(
          'injected terminal failure',
        )
      } finally {
        await sql`DROP TRIGGER fail_task_terminal ON tasks`
        await sql`DROP FUNCTION fail_task_terminal()`
      }
      expect(await f.state()).toEqual(before)
    },
  )

  it('cannot refund submitted/delivered work or an active claim, but can refund a lapsed empty claim', async () => {
    const f = await fixture()
    await tasks.claim(f.task.id, f.payee)
    expect(await f.cancel()).toBeNull()
    await sql`UPDATE tasks SET claim_expires_at = now() - interval '1 second' WHERE id = ${f.task.id}`
    expect(await f.cancel()).toMatchObject({ task: { status: 'CANCELLED' } })
    expect(await tasks.submit(f.task.id, f.payee, 'late response')).toBeNull()
    const delivered = await fixture()
    await delivered.submit()
    expect(await delivered.cancel()).toBeNull()
    expect((await tasks.get(delivered.task.id))?.status).toBe('SUBMITTED')
  })

  it('requires the real claimant and elapsed review deadline for seller release', async () => {
    const f = await fixture()
    await f.submit()
    expect(await f.settle('release')).toBeNull()
    await sql`UPDATE tasks SET review_expires_at = now() - interval '1 second' WHERE id = ${f.task.id}`
    expect(
      await tasks.finalizePayment({
        taskId: f.task.id,
        actor: wallet(),
        action: 'release',
        treasury: f.treasury,
      }),
    ).toBeNull()
    expect(await f.settle('release')).toMatchObject({ task: { status: 'SETTLED' } })
    expect(await f.settle()).toMatchObject({ alreadyFinalized: true })
  })

  it('lets exactly one economic settlement win concurrent acceptance and seller release', async () => {
    const f = await fixture()
    await f.submit()
    await sql`UPDATE tasks SET review_expires_at = now() - interval '1 second' WHERE id = ${f.task.id}`
    const result = await Promise.all([f.settle(), f.settle('release')])
    expect(result.filter((r) => r?.alreadyFinalized === false)).toHaveLength(1)
    expect(result.filter((r) => r?.alreadyFinalized === true)).toHaveLength(1)
    expect(await credits.balance(f.payee)).toBe(100)
    expect(await credits.balance(f.treasury)).toBe(2)
  })

  it('arbitrates settlement versus dispute on the same row lock', async () => {
    const f = await fixture()
    await f.submit()
    const [paid, disputed] = await Promise.all([
      f.settle(),
      tasks.advance(f.task.id, ['SUBMITTED'], 'DISPUTED', 'Review required'),
    ])
    expect([paid, disputed].filter(Boolean)).toHaveLength(1)
    expect(await credits.balance(f.payee)).toBe(paid ? 100 : 0)
  })

  it.each(['missing', 'amount', 'payer', 'partial payout', 'partial refund'] as const)(
    'refuses %s funding/payment evidence without drawing on another task',
    async (which) => {
      const f = await fixture({ funded: which !== 'missing' })
      if (which === 'amount')
        await sql`UPDATE credit_entries SET delta = delta + 1 WHERE reference = ${`task:${f.task.id}:funding:in`}`
      if (which === 'payer')
        await sql`UPDATE credit_entries SET owner = ${wallet()} WHERE reference = ${`task:${f.task.id}:funding:out`}`
      if (which === 'partial payout' || which === 'partial refund') {
        const reference = `task:${f.task.id}:${which === 'partial payout' ? 'task_earnings' : 'refund'}:out`
        await sql`INSERT INTO credit_entries(id,owner,delta,reason,reference,detail) VALUES(${randomUUID()},${ESCROW_ACCOUNT},-1,'task_earnings',${reference},${sql.json({ taskId: f.task.id })})`
      }
      await f.submit()
      const before = await f.state()
      await expect(f.settle()).rejects.toThrow()
      expect(await f.state()).toEqual(before)
    },
  )

  it('rejects an unmarked historical terminal row rather than guessing a repair', async () => {
    const f = await fixture()
    await f.submit()
    await tasks.advance(f.task.id, ['SUBMITTED'], 'SETTLED')
    const before = await f.state()
    await expect(f.settle()).rejects.toThrow('needs review')
    expect(await f.state()).toEqual(before)
  })

  it('conserves money when the platform treasury is also the payer, and omits zero-fee legs', async () => {
    const f = await fixture()
    await f.submit()
    expect(
      await tasks.finalizePayment({
        taskId: f.task.id,
        actor: f.payer,
        action: 'accept',
        treasury: f.payer,
      }),
    ).toMatchObject({ task: { status: 'SETTLED' } })
    expect(await credits.balance(f.payer)).toBe(900)
    expect(await credits.balance(f.payee)).toBe(100)
    const zero = await fixture({ fee: 0 })
    await zero.submit()
    await zero.settle()
    expect((await zero.entries()).filter((e) => e.reason === 'platform_fee')).toHaveLength(0)
    expect(await zero.settle()).toMatchObject({ alreadyFinalized: true })
  })

  it('routes acceptance, release and cancellation through the shared transaction and confirms exact retry', async () => {
    for (const action of ['accept', 'release', 'cancel'] as const) {
      const f = await fixture({ mandate: action === 'cancel' })
      if (action !== 'cancel') await f.submit()
      if (action === 'release')
        await sql`UPDATE tasks SET review_expires_at = now() - interval '1 second' WHERE id = ${f.task.id}`
      const app = Fastify()
      app.addHook('onRequest', async (request) => {
        request.session = {
          address: action === 'release' ? f.payee : f.payer,
          chainId: 56,
          exp: Math.floor(Date.now() / 1000) + 600,
        }
      })
      registerTaskRoutes(app, { tasks, credits, jobs, settlementTreasury: f.treasury })
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/tasks/${f.task.id}/${action}`,
        })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
          status: action === 'cancel' ? 'CANCELLED' : 'SETTLED',
          alreadyFinalized: false,
        })
        const before = await f.state()
        expect(
          (await app.inject({ method: 'POST', url: `/v1/tasks/${f.task.id}/${action}` })).json(),
        ).toMatchObject({ alreadyFinalized: true })
        expect(await f.state()).toEqual(before)
      } finally {
        await app.close()
      }
    }
  })

  it('recovers a committed acceptance after a lost acknowledgement without paying any leg twice', async () => {
    const f = await fixture()
    await f.submit()
    const app = Fastify()
    app.addHook('onRequest', async (request) => {
      request.session = { address: f.payer, chainId: 56, exp: Math.floor(Date.now() / 1000) + 600 }
    })
    registerTaskRoutes(app, { tasks, credits, jobs, settlementTreasury: f.treasury })
    const original = tasks.finalizePayment.bind(tasks)
    const failure = vi.spyOn(tasks, 'finalizePayment').mockImplementationOnce(async (input) => {
      await original(input)
      throw Error('private database location must not escape')
    })
    try {
      const first = await app.inject({ method: 'POST', url: `/v1/tasks/${f.task.id}/accept` })
      expect(first.statusCode).toBe(503)
      expect(first.body).not.toContain('private database')
      const before = await f.state()
      expect(before.task?.status).toBe('SETTLED')
      const retry = await app.inject({ method: 'POST', url: `/v1/tasks/${f.task.id}/accept` })
      expect(retry.statusCode).toBe(200)
      expect(retry.json()).toMatchObject({ alreadyFinalized: true })
      expect(await f.state()).toEqual(before)
    } finally {
      failure.mockRestore()
      await app.close()
    }
  })

  it('fails closed when a deployment lacks the atomic capability rather than taking the old multi-write path', async () => {
    const f = await fixture()
    await f.submit()
    const unavailable = new Proxy(tasks, {
      get(target, property, receiver) {
        return property === 'finalizePayment' ? undefined : Reflect.get(target, property, receiver)
      },
    })
    const app = Fastify()
    app.addHook('onRequest', async (request) => {
      request.session = { address: f.payer, chainId: 56, exp: Math.floor(Date.now() / 1000) + 600 }
    })
    registerTaskRoutes(app, { tasks: unavailable, credits, jobs, settlementTreasury: f.treasury })
    try {
      const before = await f.state()
      const response = await app.inject({ method: 'POST', url: `/v1/tasks/${f.task.id}/accept` })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('SETTLEMENT_UNAVAILABLE')
      expect(await f.state()).toEqual(before)
    } finally {
      await app.close()
    }
  })
})
