import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresCreditStore, RESERVE_ACCOUNT } from '../credits/store.js'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { type AssistantLimits, PostgresAssistantRequestStore } from './billing.js'
import { registerAssistantRoutes } from './routes.js'
import { AssistantRunFailure } from './usage.js'

vi.mock('./run.js', () => ({ runAssistant: vi.fn() }))
const { runAssistant } = await import('./run.js')
const run = vi.mocked(runAssistant)
const databaseUrl = process.env.DATABASE_URL
const owner = `0x${'ab'.repeat(20)}`
const other = `0x${'cd'.repeat(20)}`
const requestHash = 'a'.repeat(64)
const limits: AssistantLimits = {
  walletPerMinute: 6,
  walletDailyPoints: 100_000,
  globalDailyPoints: 1_000_000,
  globalConcurrent: 8,
  leaseSeconds: 900,
}
const completed = {
  reply: 'Finished.',
  steps: [],
  usage: { inputTokens: 1000, outputTokens: 50 },
  points: 49,
  model: 'claude-sonnet-5',
  truncated: false,
}

describe.skipIf(!databaseUrl)('durable Fast billing against PostgreSQL', () => {
  // A private schema keeps the global budgets and welcome counts independent
  // from every other test. Only this schema is removed by this suite.
  const schema = `billing_qa_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql
  let sql: postgres.Sql
  let scopedUrl: string
  let credits: PostgresCreditStore
  let secondCredits: PostgresCreditStore
  let first: PostgresAssistantRequestStore
  let second: PostgresAssistantRequestStore

  beforeAll(async () => {
    admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl as string)
    // Do not fall back to public's migration ledger or shared fixture tables.
    url.searchParams.set('search_path', schema)
    scopedUrl = url.toString()
    sql = postgres(scopedUrl, { max: 4, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS schema`)[0]?.schema).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    credits = new PostgresCreditStore(scopedUrl)
    secondCredits = new PostgresCreditStore(scopedUrl)
    first = new PostgresAssistantRequestStore(sql)
    second = new PostgresAssistantRequestStore(sql)
  }, 30_000)
  beforeEach(async () => {
    await sql`TRUNCATE assistant_requests, credit_entries, credit_balances`
    run.mockReset()
    run.mockResolvedValue(completed)
  })
  afterAll(async () => {
    await Promise.all([credits?.close(), secondCredits?.close(), sql?.end()])
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })

  const begin = (
    store: PostgresAssistantRequestStore,
    key: string,
    address = owner,
    overrides: Partial<AssistantLimits> = {},
  ) =>
    store.begin({
      owner: address,
      key,
      requestHash,
      reservedPoints: 2000,
      limits: { ...limits, ...overrides },
    })

  it('holds the welcome cap across separate connection pools and grants each wallet once', async () => {
    const grants = await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        (index % 2 ? credits : secondCredits).grantWelcome({
          owner: `0x${index.toString(16).padStart(40, '0')}`,
          points: 5000,
          dailyLimit: 200,
        }),
      ),
    )
    expect(grants.filter((grant) => grant === 'granted')).toHaveLength(200)
    const entries =
      await sql`SELECT count(*) AS count, sum(delta) AS total FROM credit_entries WHERE reason = 'welcome'`
    expect(Number(entries[0]?.count)).toBe(400)
    expect(Number(entries[0]?.total)).toBe(0)
    const grantsAgain = await Promise.all(
      Array.from({ length: 12 }, () =>
        secondCredits.grantWelcome({ owner: `0x${'0'.repeat(40)}`, points: 5000, dailyLimit: 200 }),
      ),
    )
    expect(grantsAgain.every((grant) => grant === 'already_granted')).toBe(true)
    expect(await credits.balance(`0x${'0'.repeat(40)}`)).toBe(5000)
  })

  it('admits one identical in-flight request, stores its response and isolates owners', async () => {
    const claims = await Promise.all([begin(first, 'retry'), begin(second, 'retry')])
    expect(claims.filter((claim) => claim.kind === 'started')).toHaveLength(1)
    expect(claims.filter((claim) => claim.kind === 'refused')).toMatchObject([
      { code: 'ASSISTANT_TURN_IN_PROGRESS' },
    ])
    const accepted = claims.find((claim) => claim.kind === 'started')
    if (accepted?.kind !== 'started') throw new Error('Expected an accepted turn.')
    await first.checkpoint(accepted.id, 49, 1000, 50)
    await first.complete({
      id: accepted.id,
      status: 200,
      body: { reply: 'Saved answer.' },
      points: 49,
    })
    expect(await begin(second, 'retry')).toMatchObject({
      kind: 'replayed',
      status: 200,
      body: { reply: 'Saved answer.' },
    })
    expect(
      await second.begin({
        owner,
        key: 'retry',
        requestHash: 'b'.repeat(64),
        reservedPoints: 2000,
        limits,
      }),
    ).toEqual({ kind: 'conflict' })
    expect(await begin(second, 'retry', other)).toMatchObject({ kind: 'started' })
    expect(Number((await sql`SELECT count(*) AS count FROM assistant_requests`)[0]?.count)).toBe(2)
  })

  it('reserves the global daily budget before concurrent calls and releases only known unused budget', async () => {
    const claims = await Promise.all([
      begin(first, 'a', owner, { globalDailyPoints: 3000 }),
      begin(second, 'b', other, { globalDailyPoints: 3000 }),
    ])
    expect(claims.filter((claim) => claim.kind === 'started')).toHaveLength(1)
    expect(claims.filter((claim) => claim.kind === 'refused')).toMatchObject([
      { code: 'ASSISTANT_DAILY_LIMIT' },
    ])
    const index = claims.findIndex((claim) => claim.kind === 'started')
    const accepted = claims[index]
    if (accepted?.kind !== 'started') throw new Error('Expected a reserved turn.')
    await first.complete({ id: accepted.id, status: 200, body: { reply: 'Done.' }, points: 49 })
    expect(
      await begin(second, 'next', index === 0 ? other : owner, { globalDailyPoints: 3000 }),
    ).toMatchObject({ kind: 'started' })
  })

  it('enforces deployment concurrency and wallet rate limits from database state', async () => {
    const accepted = await begin(first, 'one', owner, { globalConcurrent: 1 })
    if (accepted.kind !== 'started') throw new Error('Expected a reserved turn.')
    expect(await begin(second, 'other', other, { globalConcurrent: 1 })).toMatchObject({
      kind: 'refused',
      code: 'ASSISTANT_BUSY',
      retryAfter: 10,
    })
    await first.complete({ id: accepted.id, status: 200, body: {}, points: 49 })
    expect(await begin(second, 'two', owner, { walletPerMinute: 1 })).toMatchObject({
      kind: 'refused',
      code: 'ASSISTANT_RATE_LIMIT',
    })
  })

  it('does not re-run or free budget for expired or uncertain provider outcomes', async () => {
    const accepted = await begin(first, 'lost')
    if (accepted.kind !== 'started') throw new Error('Expected a reserved turn.')
    await first.checkpoint(accepted.id, 49, 1000, 50)
    await sql`UPDATE assistant_requests SET lease_expires_at = now() - interval '1 hour', created_at = now() - interval '2 days' WHERE id = ${accepted.id}`
    expect(await begin(second, 'lost')).toMatchObject({
      kind: 'refused',
      code: 'ASSISTANT_TURN_UNCONFIRMED',
    })
    expect(await begin(second, 'fresh')).toMatchObject({
      kind: 'refused',
      code: 'ASSISTANT_WALLET_BUSY',
    })
    expect(await begin(second, 'other', other, { globalDailyPoints: 3000 })).toMatchObject({
      kind: 'refused',
      code: 'ASSISTANT_DAILY_LIMIT',
    })
    await first.complete({
      id: accepted.id,
      status: 503,
      body: { error: { code: 'ASSISTANT_USAGE_UNCONFIRMED' } },
      points: 49,
      uncertain: true,
    })
    expect(await begin(second, 'lost')).toMatchObject({ kind: 'replayed', status: 503 })
    expect(await begin(second, 'fresh')).toMatchObject({
      kind: 'refused',
      code: 'ASSISTANT_WALLET_BUSY',
    })
  })

  it.each(['UNCONFIRMED', 'EXPIRED'] as const)(
    'eight %s turns retain their budget without permanently blocking other wallets',
    async (state) => {
      const configured = { globalDailyPoints: 18_000 }
      const owners = Array.from(
        { length: 8 },
        (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
      )
      const claims = await Promise.all(
        owners.map((address, index) =>
          begin(index % 2 ? first : second, 'lost', address, configured),
        ),
      )
      expect(claims.filter((claim) => claim.kind === 'started')).toHaveLength(8)
      expect(await begin(second, 'while-running', other, configured)).toMatchObject({
        kind: 'refused',
        code: 'ASSISTANT_BUSY',
      })
      for (const claim of claims) {
        if (claim.kind !== 'started') throw new Error('Expected an accepted turn.')
        await first.checkpoint(claim.id, 49, 1000, 50)
        if (state === 'UNCONFIRMED')
          await first.complete({
            id: claim.id,
            status: 503,
            body: { error: { code: 'ASSISTANT_USAGE_UNCONFIRMED' } },
            points: 49,
            uncertain: true,
          })
        else
          await sql`UPDATE assistant_requests SET lease_expires_at = now() - interval '1 second' WHERE id = ${claim.id}`
      }
      // The unresolved budget does not age out, including after process loss.
      await sql`UPDATE assistant_requests SET created_at = now() - interval '2 days'`
      expect(await begin(second, 'retry-with-new-key', owners[0], configured)).toMatchObject({
        kind: 'refused',
        code: 'ASSISTANT_WALLET_BUSY',
      })
      expect(await begin(second, 'new-owner', other, configured)).toMatchObject({ kind: 'started' })
      expect(await begin(first, 'over-budget', owner, configured)).toMatchObject({
        kind: 'refused',
        code: 'ASSISTANT_DAILY_LIMIT',
      })
      const unresolved = await sql`SELECT count(*) AS count, sum(reserved_points) AS reserved
        FROM assistant_requests WHERE owner = ANY(${owners})`
      expect(Number(unresolved[0]?.count)).toBe(8)
      expect(Number(unresolved[0]?.reserved)).toBe(16_000)
    },
  )

  function app(store: PostgresCreditStore) {
    const server = Fastify()
    server.addHook('onRequest', async (request) => {
      request.session = { address: owner, chainId: 97, exp: 9999999999 }
    })
    registerAssistantRoutes(server, {
      credits: store,
      apiKey: 'test-only',
      selfUrl: 'http://127.0.0.1:1',
    })
    return server
  }
  it('replays across API process instances without a second provider call or debit', async () => {
    const a = app(credits)
    const b = app(secondCredits)
    const request = {
      method: 'POST' as const,
      url: '/v1/assistant/messages',
      headers: { cookie: 'local-test-only', 'idempotency-key': 'same-http-turn' },
      payload: { messages: [{ role: 'user', content: 'Hello.' }] },
    }
    try {
      const firstResponse = await a.inject(request)
      const retry = await b.inject(request)
      expect(firstResponse.statusCode).toBe(200)
      expect(retry.statusCode).toBe(200)
      expect(retry.json()).toEqual(firstResponse.json())
      expect(run).toHaveBeenCalledTimes(1)
      expect(await credits.balance(owner)).toBe(4951)
      expect(
        Number(
          (
            await sql`SELECT count(*) AS count FROM credit_entries WHERE owner = ${owner} AND reason = 'fast_mode_hold' AND delta < 0`
          )[0]?.count,
        ),
      ).toBe(1)
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  it('persists confirmed usage and keeps the uncertain remainder held across restarts', async () => {
    run.mockRejectedValue(new AssistantRunFailure({ ...completed, truncated: true }, true))
    const a = app(credits)
    const b = app(secondCredits)
    const request = {
      method: 'POST' as const,
      url: '/v1/assistant/messages',
      headers: { cookie: 'local-test-only', 'idempotency-key': 'uncertain-http' },
      payload: { messages: [{ role: 'user', content: 'Hello.' }] },
    }
    try {
      expect((await a.inject(request)).statusCode).toBe(503)
      expect((await b.inject(request)).statusCode).toBe(503)
      expect(run).toHaveBeenCalledTimes(1)
      expect(await credits.balance(owner)).toBe(3000)
      expect(await credits.balance(RESERVE_ACCOUNT)).toBe(1951)
      const rows = await sql`SELECT state, usage_points FROM assistant_requests`
      expect(rows[0]?.state).toBe('UNCONFIRMED')
      expect(Number(rows[0]?.usage_points)).toBe(49)
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })
})
