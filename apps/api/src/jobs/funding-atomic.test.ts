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
import { SETTLEMENT } from '../settlement/pricing.js'
import { PostgresJobStore } from './postgres-store.js'
import { JobService } from './service.js'
import { InMemoryJobStore } from './store.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Job funding regressions require a loopback test database.')
const BUYER = `0x${'ab'.repeat(20)}`,
  OTHER = `0x${'cd'.repeat(20)}`,
  PRICE = 10n ** 16n,
  POINTS = 102,
  OUTLAY = (PRICE * 1025n) / 1000n
const signer = new SessionSigner('atomic-funding-local-test-secret-only')
const constraints: Constraint[] = [
  { kind: 'asset_scope', value: [SETTLEMENT.address], tier: 'T2', label: 'Settlement asset' },
  { kind: 'per_action_cap', value: OUTLAY.toString(), tier: 'T2', label: 'Per hire' },
  { kind: 'session_total_cap', value: (OUTLAY * 10n).toString(), tier: 'T2', label: 'Total' },
]
const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('fails closed when an atomic funding store is unavailable', async () => {
  const jobs = new JobService(new InMemoryJobStore()),
    credits = new InMemoryCreditStore()
  const authorization = await jobs.authorize(constraints, BUYER)
  const job = await jobs.createJob(authorization.id, randomUUID())
  const transfer = vi.spyOn(credits, 'transfer'),
    reserve = vi.spyOn(jobs, 'attemptPurchase')
  await expect(
    jobs.fundCreditJob({ jobId: job.id, buyer: BUYER, agentId: '1', price: PRICE }),
  ).rejects.toMatchObject({ code: 'JOB_FUNDING_UNAVAILABLE' })
  expect(transfer).not.toHaveBeenCalled()
  expect(reserve).not.toHaveBeenCalled()
})

describe.skipIf(!databaseUrl)('atomic legacy job funding in isolated PostgreSQL', () => {
  const schema = `job_funding_${randomUUID().replaceAll('-', '')}`
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
    sql = postgres(isolatedUrl, { max: 5, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    store = new PostgresJobStore(isolatedUrl)
    credits = new PostgresCreditStore(isolatedUrl)
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
  async function fixture(input: { constraints?: Constraint[]; balance?: number } = {}) {
    const authorizationId = randomUUID(),
      jobId = randomUUID()
    await store.createAuthorization({
      id: authorizationId,
      owner: BUYER,
      status: 'active',
      policy: compilePolicy(input.constraints ?? constraints),
      spent: 0n,
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
    await credits.deposit({
      owner: BUYER,
      points: input.balance ?? 1000,
      reason: 'test',
      reference: randomUUID(),
    })
    return { jobId, authorizationId }
  }
  function api(options: { unavailable?: boolean; asset?: string; price?: bigint } = {}) {
    const observations = vi.fn(() => {
      if (options.unavailable) throw new Error('Fresh registry lookup must not run on replay')
      return [
        ['agent.liveness_verdict', { state: 'LIVE' }],
        ['erc8004.agent_registered', { owner: OTHER }],
        [
          'erc8004.registration_resolution',
          {
            manifest: {
              pricing: {
                amount: (options.price ?? PRICE).toString(),
                asset: options.asset ?? SETTLEMENT.symbol,
              },
            },
          },
        ],
      ].map(([predicate, value]) =>
        materializeObservation({
          subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: '1' },
          predicate: String(predicate),
          value: value as Record<string, unknown>,
          source: 'local-test',
          method: 'local-test',
          evidenceClass: 'B',
          dedupeKey: String(predicate),
          validAt: new Date().toISOString(),
          observedAt: new Date().toISOString(),
        }),
      )
    })
    const app = createApiServer({
      observations,
      jobs,
      assistant: { credits, selfUrl: 'https://api.example' },
      auth: {
        signer,
        nonces: new InMemoryNonceStore(),
        domain: 'aiki.test',
        secureCookies: false,
        client: createPublicClient({ chain: bsc, transport: http('http://127.0.0.1:1') }),
      },
    })
    apps.push(app)
    return { app, observations }
  }
  const fund = (
    app: ReturnType<typeof createApiServer>,
    jobId: string,
    owner = BUYER,
    agentId = '1',
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/fund`,
      headers: { cookie: `aiki_session=${signer.issue(owner, 56)}` },
      payload: { agentId },
    })
  async function state(jobId: string, authorizationId: string) {
    return {
      job: await jobs.getJob(jobId),
      spent: (await jobs.getAuthorization(authorizationId)).spent,
      buyer: await credits.balance(BUYER),
      escrow: await credits.balance(ESCROW_ACCOUNT),
      entries:
        await sql`SELECT owner,delta::text,reference,reason,detail FROM credit_entries ORDER BY reference`,
      balances: await sql`SELECT owner,balance::text FROM credit_balances ORDER BY owner`,
    }
  }

  it('commits one sale, cap charge and transfer across concurrent cold requests', async () => {
    const f = await fixture(),
      { app } = api()
    const results = await Promise.all([fund(app, f.jobId), fund(app, f.jobId)])
    expect((await jobs.getAuthorization(f.authorizationId)).spent).toBe(OUTLAY)
    expect(results.map((r) => r.statusCode)).toEqual([200, 200])
    expect(results.map((r) => r.json().alreadyFunded).sort()).toEqual([false, true])
    expect(await state(f.jobId, f.authorizationId)).toMatchObject({
      buyer: 1000 - POINTS,
      escrow: POINTS,
      spent: OUTLAY,
      job: {
        status: 'FUNDED',
        sale: { agentId: '1', pricePoints: 100, totalPoints: POINTS, outlay: OUTLAY },
      },
    })
  })
  it('never compensates a cap after the separate credit transfer committed without acknowledgement', async () => {
    const f = await fixture(),
      { app } = api(),
      transfer = credits.transfer.bind(credits)
    vi.spyOn(credits, 'transfer').mockImplementationOnce(async (input) => {
      await transfer(input)
      throw new Error('private lost transfer COMMIT acknowledgement')
    })
    await fund(app, f.jobId)
    expect(await credits.balance(ESCROW_ACCOUNT)).toBe(POINTS)
    expect((await jobs.getAuthorization(f.authorizationId)).spent).toBe(OUTLAY)
    expect((await fund(app, f.jobId)).statusCode).toBe(200)
    expect((await jobs.getAuthorization(f.authorizationId)).spent).toBe(OUTLAY)
  })
  const attempt = (jobId: string) =>
    jobs.fundCreditJob({ jobId, buyer: BUYER, agentId: '1', price: PRICE })

  it('recovers a lost atomic COMMIT acknowledgement after restart without quote, cap or balance headroom', async () => {
    const f = await fixture({ balance: POINTS }),
      { app } = api(),
      real = store.fundCreditJob.bind(store)
    vi.spyOn(store, 'fundCreditJob').mockImplementation(async (input, evaluate) => {
      const result = await real(input, evaluate)
      if (result && !result.alreadyFunded) throw new Error('private lost COMMIT acknowledgement')
      return result
    })
    const response = await fund(app, f.jobId)
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('JOB_FUNDING_UNCONFIRMED')
    expect(response.body).not.toContain('private')
    await sql`UPDATE authorizations SET status='revoked' WHERE id=${f.authorizationId}`
    const before = await state(f.jobId, f.authorizationId),
      retry = api({ unavailable: true })
    const replay = await fund(retry.app, f.jobId)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ held: POINTS, buyerBalance: 0, alreadyFunded: true })
    expect(retry.observations).not.toHaveBeenCalled()
    const restarted = new PostgresJobStore(isolatedUrl)
    try {
      expect(
        await new JobService(restarted).fundCreditJob({
          jobId: f.jobId,
          buyer: BUYER,
          agentId: '1',
        }),
      ).toMatchObject({ alreadyFunded: true, held: POINTS })
    } finally {
      await restarted.close()
    }
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    expect(before.spent).toBe(OUTLAY)
  })
  it.each(['credit_entries', 'credit_balances', 'authorizations', 'jobs', 'job_events'] as const)(
    'rolls sale, reservation, credit legs and state back when %s fails',
    async (table) => {
      const f = await fixture(),
        before = await state(f.jobId, f.authorizationId)
      await sql.unsafe(
        "CREATE FUNCTION fail_funding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private injected funding failure'; END $$",
      )
      await sql.unsafe(
        `CREATE TRIGGER fail_funding BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_funding()`,
      )
      try {
        const response = await fund(api().app, f.jobId)
        expect(response.statusCode).toBe(503)
        expect(response.json().error.code).toBe('JOB_FUNDING_UNCONFIRMED')
        expect(response.body).not.toContain('private')
        expect(await state(f.jobId, f.authorizationId)).toEqual(before)
      } finally {
        await sql.unsafe(`DROP TRIGGER fail_funding ON ${table}`)
        await sql.unsafe('DROP FUNCTION fail_funding()')
      }
      expect(await attempt(f.jobId)).toMatchObject({ alreadyFunded: false, held: POINTS })
      expect((await jobs.getAuthorization(f.authorizationId)).spent).toBe(OUTLAY)
    },
  )
  it('rolls the outbound leg back if the inbound credit insert fails', async () => {
    const f = await fixture(),
      before = await state(f.jobId, f.authorizationId)
    await sql.unsafe(
      "CREATE FUNCTION fail_inbound() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reference LIKE '%:funding:in' THEN RAISE EXCEPTION 'inbound rejected'; END IF; RETURN NEW; END $$",
    )
    await sql.unsafe(
      'CREATE TRIGGER fail_inbound BEFORE INSERT ON credit_entries FOR EACH ROW EXECUTE FUNCTION fail_inbound()',
    )
    try {
      await expect(attempt(f.jobId)).rejects.toThrow()
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    } finally {
      await sql.unsafe('DROP TRIGGER fail_inbound ON credit_entries')
      await sql.unsafe('DROP FUNCTION fail_inbound()')
    }
  })
  it('allows only one of two jobs that share a lifetime cap', async () => {
    const capped = constraints.map((c) =>
      c.kind === 'session_total_cap' ? { ...c, value: OUTLAY.toString() } : c,
    )
    const f = await fixture({ constraints: capped }),
      second = await jobs.createJob(f.authorizationId, randomUUID())
    const results = await Promise.allSettled([attempt(f.jobId), attempt(second.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'MANDATE_REFUSED' },
    })
    expect((await jobs.getAuthorization(f.authorizationId)).spent).toBe(OUTLAY)
    expect(await credits.balance(BUYER)).toBe(1000 - POINTS)
    expect(await credits.balance(ESCROW_ACCOUNT)).toBe(POINTS)
  })
  it.each(['pending', 'revoked', 'expired'] as const)(
    'refuses fresh funding under a %s authorization without writes',
    async (status) => {
      const f = await fixture()
      await sql`UPDATE authorizations SET status=${status} WHERE id=${f.authorizationId}`
      const before = await state(f.jobId, f.authorizationId)
      await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'MANDATE_REFUSED' })
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it.each(['asset', 'missing_asset', 'per_action', 'total', 'expired'])(
    'preserves %s purchase policy refusal',
    async (kind) => {
      let policy = constraints.map((c) => ({ ...c }))
      if (kind === 'asset')
        policy = policy.map((c) => (c.kind === 'asset_scope' ? { ...c, value: [OTHER] } : c))
      if (kind === 'missing_asset') policy = policy.filter((c) => c.kind !== 'asset_scope')
      if (kind === 'per_action' || kind === 'total')
        policy = policy.map((c) =>
          c.kind === (kind === 'total' ? 'session_total_cap' : 'per_action_cap')
            ? { ...c, value: (OUTLAY - 1n).toString() }
            : c,
        )
      if (kind === 'expired')
        policy.push({
          kind: 'expiry',
          value: new Date(Date.now() - 1000).toISOString(),
          label: 'Expired',
          tier: 'T2',
        })
      const f = await fixture({ constraints: policy }),
        before = await state(f.jobId, f.authorizationId)
      await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'MANDATE_REFUSED' })
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it('preserves unsigned explicit owner-purchase semantics, not generic call or approval checks', async () => {
    const f = await fixture({
      constraints: [
        ...constraints,
        { kind: 'contract_allowlist', value: [OTHER], tier: 'T2', label: 'Call target' },
        { kind: 'selector_allowlist', value: ['0x00000000'], tier: 'T2', label: 'Call selector' },
        { kind: 'approval', value: 'approve_every', tier: 'T2', label: 'Approval' },
      ],
    })
    expect((await jobs.getAuthorization(f.authorizationId)).delegation).toBeUndefined()
    expect(await attempt(f.jobId)).toMatchObject({ alreadyFunded: false })
  })
  it('refuses a wrong owner both at HTTP and under the funding lock', async () => {
    const f = await fixture(),
      before = await state(f.jobId, f.authorizationId)
    expect((await fund(api().app, f.jobId, OTHER)).statusCode).toBe(404)
    await expect(
      jobs.fundCreditJob({ jobId: f.jobId, buyer: OTHER, agentId: '1', price: PRICE }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it('refuses insufficient points with no sale or cap reservation', async () => {
    const f = await fixture({ balance: POINTS - 1 }),
      before = await state(f.jobId, f.authorizationId)
    const response = await fund(api().app, f.jobId)
    expect(response.statusCode).toBe(402)
    expect(response.json().error.code).toBe('INSUFFICIENT_POINTS')
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it.each([0n, 1n, -1n, 1n << 256n, BigInt(Number.MAX_SAFE_INTEGER) * 10n ** 18n])(
    'rejects unsafe or zero-point raw price %s',
    async (price) => {
      const f = await fixture(),
        before = await state(f.jobId, f.authorizationId)
      await expect(
        jobs.fundCreditJob({ jobId: f.jobId, buyer: BUYER, agentId: '1', price }),
      ).rejects.toMatchObject({ code: 'JOB_FUNDING_REVIEW_REQUIRED' })
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it('does not reinterpret a differently denominated published price', async () => {
    const f = await fixture(),
      before = await state(f.jobId, f.authorizationId)
    const response = await fund(api({ asset: 'USDT' }).app, f.jobId)
    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('AGENT_PRICES_IN_ANOTHER_ASSET')
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it('uses frozen terms on a marked retry and rejects a different agent', async () => {
    const f = await fixture()
    await attempt(f.jobId)
    const before = await state(f.jobId, f.authorizationId),
      retry = api({ price: PRICE * 100n })
    expect((await fund(retry.app, f.jobId)).json()).toMatchObject({
      held: POINTS,
      alreadyFunded: true,
    })
    expect(retry.observations).not.toHaveBeenCalled()
    expect((await fund(retry.app, f.jobId, BUYER, '2')).json().error.code).toBe('JOB_ALREADY_SOLD')
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it.each(['sale', 'funding', 'sale_and_funding', 'partial_funding'])(
    'fails closed for unmarked historical AUTHORIZED %s',
    async (kind) => {
      const f = await fixture()
      await sql`UPDATE authorizations SET spent=${(OUTLAY * 3n).toString()} WHERE id=${f.authorizationId}`
      if (kind.includes('sale'))
        await store.recordSale(f.jobId, {
          agentId: '1',
          pricePoints: 100,
          totalPoints: POINTS,
          outlay: OUTLAY,
        })
      if (kind.includes('funding'))
        await credits.transfer({
          from: BUYER,
          to: ESCROW_ACCOUNT,
          points: POINTS,
          reason: 'job_funding',
          reference: `job:${f.jobId}:funding`,
        })
      if (kind === 'partial_funding')
        await sql`DELETE FROM credit_entries WHERE reference=${`job:${f.jobId}:funding:in`}`
      const before = await state(f.jobId, f.authorizationId),
        h = api({ unavailable: true })
      expect((await fund(h.app, f.jobId)).json().error.code).toBe('JOB_FUNDING_REVIEW_REQUIRED')
      expect(h.observations).not.toHaveBeenCalled()
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it.each(['marker', 'inbound', 'payer', 'amount', 'spent', 'policy'])(
    'refuses corrupt marked funding proof: %s',
    async (kind) => {
      const f = await fixture()
      await attempt(f.jobId)
      if (kind === 'marker')
        await sql`DELETE FROM job_events WHERE job_id=${f.jobId} AND type='spend'`
      if (kind === 'inbound')
        await sql`DELETE FROM credit_entries WHERE reference=${`job:${f.jobId}:funding:in`}`
      if (kind === 'payer')
        await sql`UPDATE credit_entries SET owner=${OTHER} WHERE reference=${`job:${f.jobId}:funding:out`}`
      if (kind === 'amount')
        await sql`UPDATE credit_entries SET delta=delta+1 WHERE reference=${`job:${f.jobId}:funding:in`}`
      if (kind === 'spent')
        await sql`UPDATE authorizations SET spent=0 WHERE id=${f.authorizationId}`
      if (kind === 'policy')
        await sql`UPDATE authorizations SET policy=jsonb_set(policy,'{hash}','"changed"') WHERE id=${f.authorizationId}`
      const before = await state(f.jobId, f.authorizationId)
      await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'JOB_FUNDING_REVIEW_REQUIRED' })
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it('refunds a new atomic funding once, and no fund retry can reopen it', async () => {
    const f = await fixture()
    await attempt(f.jobId)
    expect(
      await jobs.refundFundedJob({ jobId: f.jobId, buyer: BUYER, because: 'Cancelled locally' }),
    ).toEqual({ refunded: POINTS, alreadyRefunded: false })
    const before = await state(f.jobId, f.authorizationId)
    await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'JOB_NOT_FUNDABLE' })
    expect(await jobs.refundFundedJob({ jobId: f.jobId, buyer: BUYER, because: 'Retry' })).toEqual({
      refunded: 0,
      alreadyRefunded: true,
    })
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    expect(before).toMatchObject({
      spent: 0n,
      buyer: 1000,
      escrow: 0,
      job: { status: 'CANCELLED' },
    })
  })
  it.each(['revoked', 'expiry'])(
    'checks %s after waiting for the authorization lock',
    async (kind) => {
      const now = Date.now(),
        policy = [
          ...constraints,
          {
            kind: 'expiry' as const,
            value: new Date(now + 60_000).toISOString(),
            tier: 'T2' as const,
            label: 'Expiry',
          },
        ]
      const f = await fixture({ constraints: policy })
      let unlock = () => {},
        markLocked = (_pid: number) => {}
      const released = new Promise<void>((resolve) => {
        unlock = resolve
      })
      const locked = new Promise<number>((resolve) => {
        markLocked = resolve
      })
      const blocker = sql.begin(async (tx) => {
        await tx`SELECT id FROM authorizations WHERE id=${f.authorizationId} FOR UPDATE`
        const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        if (!row) throw new Error('Missing blocker PID')
        markLocked(row.pid)
        await released
        if (kind === 'revoked')
          await tx`UPDATE authorizations SET status='revoked' WHERE id=${f.authorizationId}`
      })
      const pid = await locked,
        pending = attempt(f.jobId).then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      try {
        await expect
          .poll(
            async () => {
              const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::integer AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
        `
              return row?.n ?? 0
            },
            { timeout: 2000 },
          )
          .toBeGreaterThan(0)
        if (kind === 'expiry') {
          vi.useFakeTimers({ toFake: ['Date'] })
          vi.setSystemTime(now + 120_000)
        }
      } finally {
        unlock()
        await blocker
      }
      expect(await pending).toMatchObject({ error: { code: 'MANDATE_REFUSED' } })
      expect(await state(f.jobId, f.authorizationId)).toMatchObject({
        spent: 0n,
        buyer: 1000,
        escrow: 0,
        job: { status: 'AUTHORIZED' },
      })
      expect((await jobs.getJob(f.jobId)).sale).toBeUndefined()
    },
  )
  it.each(['PAUSED', 'ACTIVE', 'CLOSED'] as const)(
    'blocks a %s strategy authorization even when it names the settlement asset',
    async (status) => {
      const f = await fixture(),
        hash = `0x${'12'.repeat(32)}`
      await sql`
      INSERT INTO strategy_watches
        (id, authorization_id, job_id, chain_id, vault, controller, policy_hash, runtime_code_hash,
         kind, manager, executor, binding_enforcer, status, checkpoint_nonce, checkpoint, policy,
         gas_limit_wei, expires_at)
      VALUES (${randomUUID()}, ${f.authorizationId}, ${f.jobId}, 56, ${OTHER}, ${BUYER}, ${hash}, ${hash},
        'yield', ${OTHER}, ${OTHER}, ${OTHER}, ${status}, 0, '{}'::jsonb, '{}'::jsonb, 1, now()+interval '1 day')
    `
      const before = await state(f.jobId, f.authorizationId)
      await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'STRATEGY_EXECUTION_REQUIRED' })
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it.each([(1n << 256n) - OUTLAY, 1n << 256n])(
    'rejects uint256 aggregate spend overflow at %s',
    async (spent) => {
      const f = await fixture({
        constraints: constraints.filter((c) => c.kind !== 'session_total_cap'),
      })
      await sql`UPDATE authorizations SET spent=${spent.toString()} WHERE id=${f.authorizationId}`
      const before = await state(f.jobId, f.authorizationId)
      await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'JOB_FUNDING_REVIEW_REQUIRED' })
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it('rejects a zero owner at the store boundary before writing balances', async () => {
    const f = await fixture(),
      zero = `0x${'0'.repeat(40)}`
    await sql`UPDATE authorizations SET owner=${zero} WHERE id=${f.authorizationId}`
    const before = await state(f.jobId, f.authorizationId)
    await expect(
      jobs.fundCreditJob({ jobId: f.jobId, buyer: zero, agentId: '1', price: PRICE }),
    ).rejects.toMatchObject({ code: 'JOB_FUNDING_REVIEW_REQUIRED' })
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
  it.each(['CANCELLED', 'SETTLED'] as const)(
    'never reopens a %s job on marked retry',
    async (status) => {
      const f = await fixture()
      await attempt(f.jobId)
      await sql`UPDATE jobs SET status=${status} WHERE id=${f.jobId}`
      const before = await state(f.jobId, f.authorizationId)
      await expect(attempt(f.jobId)).rejects.toMatchObject({ code: 'JOB_NOT_FUNDABLE' })
      expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    },
  )
  it('serializes a funding replay against a refund without reopening or moving twice', async () => {
    const f = await fixture()
    await attempt(f.jobId)
    const result = await Promise.allSettled([
      attempt(f.jobId),
      jobs.refundFundedJob({ jobId: f.jobId, buyer: BUYER, because: 'Cancelled' }),
    ])
    expect(result[1]).toMatchObject({ status: 'fulfilled', value: { refunded: POINTS } })
    if (result[0]?.status === 'rejected')
      expect(result[0].reason).toMatchObject({ code: 'JOB_NOT_FUNDABLE' })
    expect(await state(f.jobId, f.authorizationId)).toMatchObject({
      spent: 0n,
      buyer: 1000,
      escrow: 0,
      job: { status: 'CANCELLED' },
    })
  })
  it('does not release another reservation when historical lost-ACK funding has no original cap proof', async () => {
    const f = await fixture()
    await store.recordSale(f.jobId, {
      agentId: '1',
      pricePoints: 100,
      totalPoints: POINTS,
      outlay: OUTLAY,
    })
    await credits.transfer({
      from: BUYER,
      to: ESCROW_ACCOUNT,
      points: POINTS,
      reason: 'job_funding',
      reference: `job:${f.jobId}:funding`,
    })
    // Old lost-ACK compensation released this job's reservation. This amount
    // belongs to other work, despite being enough to pass an aggregate check.
    await sql`UPDATE authorizations SET spent=${(OUTLAY * 2n).toString()} WHERE id=${f.authorizationId}`
    await store.claimCreditPayment({ jobId: f.jobId, buyer: BUYER, status: 'FUNDED' })
    const before = await state(f.jobId, f.authorizationId)
    const historical = api({ unavailable: true })
    const readback = await fund(historical.app, f.jobId)
    expect(readback.statusCode).toBe(409)
    expect(readback.json().error.code).toBe('JOB_ALREADY_FUNDED')
    expect(historical.observations).not.toHaveBeenCalled()
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
    await expect(
      jobs.refundFundedJob({ jobId: f.jobId, buyer: BUYER, because: 'Legacy review' }),
    ).rejects.toMatchObject({ code: 'JOB_REFUND_REVIEW_REQUIRED' })
    expect(await state(f.jobId, f.authorizationId)).toEqual(before)
  })
})
