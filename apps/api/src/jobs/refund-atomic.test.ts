import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { type Constraint, compilePolicy } from '../authority/policy.js'
import { ESCROW_ACCOUNT, InMemoryCreditStore, PostgresCreditStore } from '../credits/store.js'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { materializeObservation } from '../evidence/store.js'
import { createApiServer } from '../http/server.js'
import { fundJob, refundJob } from '../settlement/ledger.js'
import { SETTLEMENT } from '../settlement/pricing.js'
import { PostgresJobStore } from './postgres-store.js'
import { JobService } from './service.js'
import { InMemoryJobStore, type JobRecord } from './store.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Job refund regressions require a loopback test database.')
const BUYER = `0x${'ab'.repeat(20)}`,
  OTHER = `0x${'cd'.repeat(20)}`,
  TREASURY = `0x${'ef'.repeat(20)}`,
  POINTS = 102,
  PRICE = 10n ** 16n,
  OUTLAY = (PRICE * 1025n) / 1000n,
  OTHER_SPEND = 100n
const signer = new SessionSigner('atomic-refund-local-test-secret-only')
const constraints: Constraint[] = [
  { kind: 'asset_scope', value: [SETTLEMENT.address], tier: 'T2', label: 'Settlement asset' },
  { kind: 'session_total_cap', value: (OUTLAY * 10n).toString(), tier: 'T2', label: 'Test cap' },
]
const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

function api(jobs: JobService, credits: InMemoryCreditStore | PostgresCreditStore) {
  const app = createApiServer({
    observations: () => [
      materializeObservation({
        subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: '1' },
        predicate: 'erc8004.agent_registered',
        value: { owner: OTHER },
        source: 'local-test',
        method: 'local-test',
        evidenceClass: 'B',
        dedupeKey: 'owner',
        validAt: '2026-09-01T00:00:00.000Z',
        observedAt: '2026-09-01T00:00:00.000Z',
      }),
    ],
    jobs,
    settlementTreasury: TREASURY,
    assistant: { credits, selfUrl: 'https://api.example' },
    auth: {
      signer,
      nonces: new InMemoryNonceStore(),
      domain: 'aiki.test',
      secureCookies: false,
      // Requests below only validate session cookies; this transport is never called.
      client: createPublicClient({ chain: bsc, transport: http('http://127.0.0.1:1') }),
    },
  })
  apps.push(app)
  return app
}
const refund = (app: ReturnType<typeof createApiServer>, id: string, owner = BUYER) =>
  app.inject({
    method: 'POST',
    url: `/v1/jobs/${id}/refund`,
    headers: { cookie: `aiki_session=${signer.issue(owner, 56)}` },
    payload: { because: 'test' },
  })

it('fails closed without a shared atomic job/credit store', async () => {
  const store = new InMemoryJobStore(),
    credits = new InMemoryCreditStore(),
    jobs = new JobService(store)
  const authorization = await jobs.authorize(constraints, BUYER)
  const job: JobRecord = {
    id: randomUUID(),
    authorizationId: authorization.id,
    status: 'FUNDED',
    events: [],
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
    sale: { agentId: '1', pricePoints: 100, totalPoints: POINTS, outlay: OUTLAY },
  }
  await store.createJob(job)
  const release = vi.spyOn(jobs, 'releaseSpend'),
    transfer = vi.spyOn(credits, 'transfer')
  const response = await refund(api(jobs, credits), job.id)
  expect(response.statusCode).toBe(503)
  expect(response.json().error.code).toBe('JOB_REFUND_UNAVAILABLE')
  expect((await jobs.getJob(job.id)).status).toBe('FUNDED')
  expect(release).not.toHaveBeenCalled()
  expect(transfer).not.toHaveBeenCalled()
})

describe.skipIf(!databaseUrl)('atomic legacy job refunds in isolated PostgreSQL', () => {
  const schema = `job_refund_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql,
    sql: postgres.Sql,
    store: PostgresJobStore,
    credits: PostgresCreditStore,
    jobs: JobService,
    isolatedUrl: string
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Missing local DB')
    admin = postgres(databaseUrl, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl)
    url.searchParams.set('search_path', schema)
    isolatedUrl = url.toString()
    sql = postgres(url.toString(), { max: 5, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    store = new PostgresJobStore(url.toString())
    credits = new PostgresCreditStore(url.toString())
    jobs = new JobService(store)
  }, 30_000)
  afterEach(async () => {
    if (sql) await sql`TRUNCATE jobs,authorizations,credit_entries,credit_balances CASCADE`
  })
  afterAll(async () => {
    try {
      await Promise.allSettled([store?.close(), credits?.close(), sql?.end({ timeout: 5 })])
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
  async function fixture(payer = BUYER) {
    const authorizationId = randomUUID(),
      jobId = randomUUID()
    await store.createAuthorization({
      id: authorizationId,
      owner: BUYER,
      status: 'active',
      policy: compilePolicy(constraints),
      spent: OTHER_SPEND,
      createdAt: new Date().toISOString(),
    })
    await store.createJob({
      id: jobId,
      authorizationId,
      status: 'AUTHORIZED',
      events: [],
      idempotencyKey: randomUUID(),
      createdAt: new Date().toISOString(),
    })
    await credits.deposit({ owner: payer, points: 1000, reason: 'test', reference: randomUUID() })
    if (payer === BUYER) {
      await jobs.fundCreditJob({ jobId, buyer: BUYER, agentId: '1', price: PRICE })
    } else {
      // Deliberately inconsistent legacy payer, only used by refusal cases.
      await store.recordSale(jobId, {
        agentId: '1',
        pricePoints: 100,
        totalPoints: POINTS,
        outlay: OUTLAY,
      })
      await fundJob({ credits, jobId, buyer: payer, totalPoints: POINTS })
      await store.claim(jobId, ['AUTHORIZED'], 'FUNDED', 'Legacy funding')
    }
    return { jobId, authorizationId }
  }
  const attempt = (jobId: string) => store.refundFundedJob({ jobId, buyer: BUYER, because: 'test' })
  async function state(jobId: string, authorizationId: string) {
    return {
      job: await jobs.getJob(jobId),
      spent: (await jobs.getAuthorization(authorizationId)).spent,
      buyer: await credits.balance(BUYER),
      escrow: await credits.balance(ESCROW_ACCOUNT),
      entries:
        await sql`SELECT owner,delta::text,reference,reason,detail FROM credit_entries ORDER BY reference`,
    }
  }
  it('refunds and releases once across concurrent HTTP retries and a new store instance', async () => {
    const f = await fixture(),
      app = api(jobs, credits)
    const results = await Promise.all([refund(app, f.jobId), refund(app, f.jobId)])
    expect(results.map((r) => r.statusCode)).toEqual([200, 200])
    expect(results.map((r) => r.json().refunded).sort((a, b) => a - b)).toEqual([0, POINTS])
    const before = await state(f.jobId, f.authorizationId)
    expect(before).toMatchObject({
      buyer: 1000,
      escrow: 0,
      spent: OTHER_SPEND,
      job: { status: 'CANCELLED' },
    })
    const retryStore = new PostgresJobStore(isolatedUrl)
    try {
      expect(
        await retryStore.refundFundedJob({ jobId: f.jobId, buyer: BUYER, because: 'retry' }),
      ).toEqual({ refunded: 0, alreadyRefunded: true })
    } finally {
      await retryStore.close()
    }
    expect((await refund(app, f.jobId)).json()).toMatchObject({
      refunded: 0,
      alreadyRefunded: true,
    })
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it.each(['credit_entries', 'credit_balances', 'authorizations', 'jobs', 'job_events'] as const)(
    'rolls all effects back when %s fails, then safely retries',
    async (table) => {
      const f = await fixture(),
        before = await state(f.jobId, f.authorizationId)
      await sql.unsafe(
        "CREATE FUNCTION fail_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected private database failure'; END $$",
      )
      await sql.unsafe(
        `CREATE TRIGGER fail_refund BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_refund()`,
      )
      try {
        const response = await refund(api(jobs, credits), f.jobId)
        expect(response.statusCode).toBe(503)
        expect(response.json().error.code).toBe('JOB_REFUND_UNCONFIRMED')
        expect(response.body).not.toContain('private database')
        expect(await state(f.jobId, f.authorizationId)).toEqual(before)
      } finally {
        await sql.unsafe(`DROP TRIGGER fail_refund ON ${table}`)
        await sql.unsafe('DROP FUNCTION fail_refund()')
      }
      expect(await attempt(f.jobId)).toEqual({ refunded: POINTS, alreadyRefunded: false })
      expect((await jobs.getAuthorization(f.authorizationId)).spent).toBe(OTHER_SPEND)
    },
  )
  it('recovers a lost commit acknowledgement without another refund or cap release', async () => {
    const f = await fixture(),
      real = store.refundFundedJob.bind(store),
      app = api(jobs, credits)
    vi.spyOn(store, 'refundFundedJob').mockImplementationOnce(async (input) => {
      await real(input)
      throw new Error('private connection lost after COMMIT')
    })
    expect((await refund(app, f.jobId)).statusCode).toBe(503)
    const before = await state(f.jobId, f.authorizationId)
    expect((await refund(app, f.jobId)).json()).toMatchObject({
      refunded: 0,
      alreadyRefunded: true,
    })
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    expect(before.spent).toBe(OTHER_SPEND)
  })
  it('arbitrates settlement versus refund on the job row', async () => {
    const f = await fixture()
    const [settled, refunded] = await Promise.all([
      store.claim(f.jobId, ['FUNDED', 'COMPLETED', 'SETTLED'], 'SETTLED', 'settle'),
      attempt(f.jobId),
    ])
    expect(Number(settled) + Number(refunded !== null)).toBe(1)
    expect((await jobs.getAuthorization(f.authorizationId)).spent).toBe(
      settled ? OUTLAY + OTHER_SPEND : OTHER_SPEND,
    )
    expect(await credits.balance(ESCROW_ACCOUNT)).toBe(settled ? POINTS : 0)
  })
  it('refuses a different actual payer and leaves all money and cap untouched', async () => {
    const f = await fixture(OTHER),
      before = await state(f.jobId, f.authorizationId)
    await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'JOB_REFUND_REVIEW_REQUIRED' })
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it('isolates the owner before reaching the atomic primitive', async () => {
    const f = await fixture(),
      called = vi.spyOn(store, 'refundFundedJob')
    expect((await refund(api(jobs, credits), f.jobId, OTHER)).statusCode).toBe(404)
    expect(called).not.toHaveBeenCalled()
  })
  it.each([
    'missing_leg',
    'wrong_reason',
    'wrong_amount',
    'spent_too_low',
    'amount_overflow',
    'payout_exists',
  ])('fails closed on inconsistent %s evidence even with pooled escrow', async (bad) => {
    const f = await fixture()
    await credits.deposit({
      owner: ESCROW_ACCOUNT,
      points: 2000,
      reason: 'test',
      reference: randomUUID(),
    })
    if (bad === 'missing_leg')
      await sql`DELETE FROM credit_entries WHERE reference = ${`job:${f.jobId}:funding:in`}`
    if (bad === 'wrong_reason')
      await sql`UPDATE credit_entries SET reason = 'other' WHERE reference = ${`job:${f.jobId}:funding:in`}`
    if (bad === 'wrong_amount')
      await sql`UPDATE credit_entries SET delta = delta + 1 WHERE reference = ${`job:${f.jobId}:funding:in`}`
    if (bad === 'spent_too_low')
      await sql`UPDATE authorizations SET spent = 1 WHERE id = ${f.authorizationId}`
    if (bad === 'amount_overflow')
      await sql`UPDATE jobs SET sold_total_points = 9007199254740992 WHERE id = ${f.jobId}`
    if (bad === 'payout_exists')
      await credits.transfer({
        from: ESCROW_ACCOUNT,
        to: OTHER,
        points: 1,
        reason: 'job_earnings',
        reference: `job:${f.jobId}:job_earnings`,
      })
    const before = await state(f.jobId, f.authorizationId)
    await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'JOB_REFUND_REVIEW_REQUIRED' })
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it.each([false, true])(
    'does not infer cap release for historical CANCELLED (refund present=%s)',
    async (refunded) => {
      const f = await fixture()
      await store.claim(f.jobId, ['FUNDED'], 'CANCELLED', 'Legacy non-atomic cancellation')
      if (refunded)
        await refundJob({
          credits,
          jobId: f.jobId,
          buyer: BUYER,
          totalPoints: POINTS,
          because: 'legacy',
        })
      const before = await state(f.jobId, f.authorizationId)
      await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'JOB_REFUND_REVIEW_REQUIRED' })
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )

  const payment = (
    app: ReturnType<typeof createApiServer>,
    id: string,
    action: 'fund' | 'settle',
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/jobs/${id}/${action}`,
      headers: { cookie: `aiki_session=${signer.issue(BUYER, 56)}` },
      payload: { agentId: '1' },
    })
  it('replays a FUNDED payment without reserving or releasing any additional cap', async () => {
    const f = await fixture(),
      app = api(jobs, credits),
      before = await state(f.jobId, f.authorizationId)
    const reserve = vi.spyOn(jobs, 'attemptPurchase'),
      release = vi.spyOn(jobs, 'releaseSpend')
    expect((await payment(app, f.jobId, 'fund')).json()).toMatchObject({
      alreadyFunded: true,
      status: 'FUNDED',
    })
    expect(reserve).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it.each(['CANCELLED', 'SETTLED'] as const)(
    'does not reopen %s from a funding retry',
    async (status) => {
      const f = await fixture(),
        app = api(jobs, credits)
      if (status === 'CANCELLED') await attempt(f.jobId)
      else
        expect(await store.claimCreditPayment({ jobId: f.jobId, buyer: BUYER, status })).toBe(true)
      const before = await state(f.jobId, f.authorizationId),
        reserve = vi.spyOn(jobs, 'attemptPurchase')
      expect((await payment(app, f.jobId, 'fund')).json().error.code).toBe('JOB_NOT_FUNDABLE')
      expect(
        await store.claimCreditPayment({ jobId: f.jobId, buyer: BUYER, status: 'FUNDED' }),
      ).toBe(false)
      expect(reserve).not.toHaveBeenCalled()
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it('a duplicate funding request that read FUNDED cannot reopen a concurrent refund', async () => {
    const f = await fixture(),
      app = api(jobs, credits),
      real = store.fundCreditJob.bind(store)
    vi.spyOn(store, 'fundCreditJob').mockImplementationOnce(async (input, evaluate) => {
      await attempt(f.jobId)
      return real(input, evaluate)
    })
    expect((await payment(app, f.jobId, 'fund')).json().error.code).toBe('JOB_NOT_FUNDABLE')
    expect(await state(f.jobId, f.authorizationId)).toMatchObject({
      job: { status: 'CANCELLED' },
      buyer: 1000,
      escrow: 0,
      spent: OTHER_SPEND,
    })
  })
  it.each(['refunded', 'unfunded', 'wrong_payer', 'price_mismatch'])(
    "does not pay a %s sale from another job's pooled escrow",
    async (bad) => {
      const f = await fixture(bad === 'wrong_payer' ? OTHER : BUYER),
        app = api(jobs, credits)
      if (bad === 'refunded') {
        await attempt(f.jobId)
        // Historical corruption/reopening must also be rejected, not merely current CANCELLED.
        await jobs.advance(f.jobId, 'FUNDED', 'Legacy reopened row')
      }
      if (bad === 'unfunded')
        await sql`DELETE FROM credit_entries WHERE reference LIKE ${`job:${f.jobId}:funding:%`}`
      if (bad === 'price_mismatch')
        await sql`UPDATE jobs SET sold_price_points = 101 WHERE id = ${f.jobId}`
      await credits.deposit({
        owner: ESCROW_ACCOUNT,
        points: 1000,
        reason: 'test',
        reference: randomUUID(),
      })
      const before = await state(f.jobId, f.authorizationId)
      const response = await payment(app, f.jobId, 'settle')
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('JOB_PAYMENT_REVIEW_REQUIRED')
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
      expect(await credits.balance(TREASURY)).toBe(0)
    },
  )
  it('settles valid original funding and resumes a mid-payout failure without duplicate earnings', async () => {
    const f = await fixture(),
      app = api(jobs, credits),
      transfer = credits.transfer.bind(credits)
    vi.spyOn(credits, 'transfer').mockImplementation(async (input) => {
      if (input.reason === 'platform_fee') throw new Error('injected before fee transfer')
      return transfer(input)
    })
    expect((await payment(app, f.jobId, 'settle')).statusCode).toBe(500)
    expect(await credits.balance(OTHER)).toBe(100)
    expect(await credits.balance(ESCROW_ACCOUNT)).toBe(2)
    vi.restoreAllMocks()
    expect((await payment(app, f.jobId, 'settle')).statusCode).toBe(200)
    expect(await credits.balance(OTHER)).toBe(100)
    expect(await credits.balance(TREASURY)).toBe(2)
    expect(await credits.balance(ESCROW_ACCOUNT)).toBe(0)
    expect(await attempt(f.jobId)).toBeNull()
    expect((await jobs.getAuthorization(f.authorizationId)).spent).toBe(OUTLAY + OTHER_SPEND)
  })
})
