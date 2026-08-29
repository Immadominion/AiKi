import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterEach, expect, it } from 'vitest'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'
import { InMemoryEvidenceStore } from '../evidence/store.js'
import { createApiServer } from './server.js'

const SECRET = 'server-test-secret-long-enough-here'
const signer = new SessionSigner(SECRET)

/** These tests exercise routes, not sign-in; auth.test.ts covers the SIWE path. */
const authConfig = () => ({
  signer,
  nonces: new InMemoryNonceStore(),
  domain: 'aiki.test',
  secureCookies: false,
  client: createPublicClient({ chain: bsc, transport: http('http://127.0.0.1:1') }),
})
const OWNER = `0x${'ab'.repeat(20)}`
const cookie = { cookie: `aiki_session=${signer.issue(OWNER, 56)}` }

const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
it('serves evidence-first passport and requires idempotency for jobs', async () => {
  const store = new InMemoryEvidenceStore()
  await store.append({
    subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: '1' },
    predicate: 'agent.liveness_verdict',
    value: { state: 'LIVE' },
    validAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    method: 'test',
    evidenceClass: 'B',
    dedupeKey: '1',
  })
  const app = createApiServer({ observations: () => store.observations, auth: authConfig() })
  apps.push(app)
  expect((await app.inject('/v1/agents/1/passport')).json().liveness).toBe('LIVE')
  const auth = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: cookie,
    payload: {
      constraints: [{ kind: 'session_total_cap', label: 'cap', value: '10', tier: 'T2' }],
    },
  })
  const noKey = await app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: cookie,
    payload: { authorizationId: auth.json().id },
  })
  expect(noKey.statusCode).toBe(400)
  const job = await app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: { ...cookie, 'idempotency-key': 'one' },
    payload: { authorizationId: auth.json().id },
  })
  expect(job.statusCode).toBe(200)
})

it('serves intent, search, quote, SSE snapshot, receipt retrieval, and Arena endpoints', async () => {
  const store = new InMemoryEvidenceStore()
  await store.append({
    subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: 'venus-1' },
    predicate: 'agent.liveness_verdict',
    value: { state: 'LIVE' },
    validAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    method: 'test',
    evidenceClass: 'B',
    dedupeKey: 'live',
  })
  const app = createApiServer({ observations: () => store.observations, auth: authConfig() })
  apps.push(app)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/intent',
        payload: { text: 'monitor my Venus health factor' },
      })
    ).json().parsed.category,
  ).toBe('health_factor')
  expect(
    (await app.inject({ method: 'POST', url: '/v1/search', payload: { query: 'live' } }))
      .statusCode,
  ).toBe(200)
  // A LIVE agent that publishes no price is refused rather than quoted at zero.
  const unpriced = await app.inject({
    method: 'POST',
    url: '/v1/quotes',
    payload: { agentId: 'venus-1' },
  })
  expect(unpriced.statusCode).toBe(422)
  expect(unpriced.json().error.code).toBe('AGENT_HAS_NO_PUBLISHED_PRICE')
  const auth = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: cookie,
    payload: {
      constraints: [{ kind: 'session_total_cap', label: 'cap', value: '10', tier: 'T2' }],
    },
  })
  const job = await app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: { ...cookie, 'idempotency-key': 'sse' },
    payload: { authorizationId: auth.json().id },
  })
  const jobId = job.json().id
  expect(
    (await app.inject({ url: `/v1/jobs/${jobId}/events`, headers: cookie })).headers[
      'content-type'
    ],
  ).toContain('text/event-stream')
  const receipt = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/receipt`,
    headers: cookie,
  })
  expect((await app.inject(`/v1/receipts/${receipt.json().receiptId}`)).statusCode).toBe(200)
  // Benchmark ingestion is token-gated: the harness writes here, browsers do not.
  process.env.ARENA_INGEST_TOKEN = 'test-ingest-token'
  const arena = await app.inject({
    method: 'POST',
    url: '/v1/arena/runs',
    headers: { authorization: 'Bearer test-ingest-token' },
    payload: {
      scenarioId: 'health-threshold',
      scenarioVersion: '1',
      forkBlock: 1,
      agentId: 'venus-1',
      baselineSuccesses: 1,
      agentSuccesses: 2,
      trials: 3,
      startedAt: '2026-01-01T00:00:00.000Z',
    },
  })
  expect((await app.inject(`/v1/arena/runs/${arena.json().id}`)).json().evidence).toBeDefined()
})

it('search coverage names what the liveness filter excluded, and total survives the limit', async () => {
  const store = new InMemoryEvidenceStore()
  const states = ['LIVE', 'DECLARED_ONLY', 'IMPOSTOR_STATIC', 'LIVE']
  for (const [index, state] of states.entries())
    await store.append({
      subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: `a${index}` },
      predicate: 'agent.liveness_verdict',
      value: { state },
      validAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:00.000Z',
      source: 'test',
      method: 'test',
      evidenceClass: 'B',
      dedupeKey: `cov-${index}`,
    })
  const app = createApiServer({ observations: () => store.observations, auth: authConfig() })
  apps.push(app)
  const response = await app.inject({
    method: 'POST',
    url: '/v1/search',
    payload: { filters: { liveness: ['LIVE'] }, limit: 1 },
  })
  const body = response.json()
  expect(body.total).toBe(2)
  expect(body.results).toHaveLength(1)
  expect(body.coverage).toEqual({
    indexedAgents: 4,
    matchedBeforeFilters: 4,
    excludedUnverified: 2,
    exclusionReasons: { DECLARED_ONLY: 1, IMPOSTOR_STATIC: 1 },
  })
})

it('finds agents a capped read model has already forgotten, and counts exclusions over every row', async () => {
  // The failure this reproduces: /v1/stats counted 13 LIVE agents on production
  // while /v1/search could see 4, because search projected over the newest page
  // of observations and the other nine had aged out of it. The four that
  // survived were simply the most recently probed, which were our own.
  const verdict = (agentId: string, state: string) => ({
    id: `obs-${agentId}`,
    subject: { type: 'agent' as const, chainId: 56, registry: '0x8004', agentId },
    predicate: 'agent.liveness_verdict',
    value: { state },
    validAt: '2026-08-01T00:00:00.000Z',
    observedAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-01T00:00:00.000Z',
    source: 'prober',
    method: 'probe/v1',
    evidenceClass: 'B' as const,
    dedupeKey: `d-${agentId}`,
  })

  const app = createApiServer({
    // The capped page: it can only see one of the two live agents.
    observations: () => [verdict('recent', 'LIVE')],
    // The store, selected in SQL: it can see both.
    observationsForLiveness: () => [verdict('recent', 'LIVE'), verdict('ancient', 'LIVE')],
    statsAggregate: () => ({
      indexed: {
        totalAgents: 100,
        bscAgents: 100,
        firstIndexedBlock: 1,
        lastIndexedBlock: 2,
        lastIndexedAt: '2026-08-01T00:00:00.000Z',
      },
      probed: {
        agentsProbed: 40,
        byRawState: { LIVE: 2, IMPOSTOR_STATIC: 38 },
        lastProbeSweepAt: '2026-08-01T00:00:00.000Z',
      },
    }),
  })
  apps.push(app)

  const res = await app.inject({
    method: 'POST',
    url: '/v1/search',
    payload: { filters: { liveness: ['LIVE'] }, limit: 100 },
  })
  const body = res.json()
  expect(body.results.map((r: { agentId: string }) => r.agentId).sort()).toEqual([
    'ancient',
    'recent',
  ])
  expect(body.total).toBe(2)
  // The honesty block agrees with the aggregate rather than with one page of it:
  // 100 indexed, 38 impostors excluded, and the 60 never probed at all.
  expect(body.coverage.indexedAgents).toBe(100)
  expect(body.coverage.exclusionReasons).toEqual({ IMPOSTOR_STATIC: 38, UNPROBED: 60 })
  expect(body.coverage.excludedUnverified).toBe(98)
})

it('refuses a comparison large enough to hold the event loop', async () => {
  const app = createApiServer({ observations: () => [] })
  apps.push(app)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/compare',
    payload: { agentIds: Array.from({ length: 5_000 }, (_, i) => String(i)) },
  })
  expect(res.statusCode).toBe(400)
  expect(res.json().error.code).toBe('TOO_MANY_AGENTS')
})

it('revokes a mandate when the caller sends a JSON content type and no body', async () => {
  // Exactly how apps/web/src/lib/api.ts calls it: `req()` sets
  // content-type: application/json on every request, and revoke passes no body.
  // Fastify's default parser refused that outright, so revoke answered 500 in
  // the browser and 200 from curl. Revoke is the control someone reaches for
  // when they want a thing to stop.
  const app = createApiServer({ observations: () => [], auth: authConfig() })
  apps.push(app)
  const created = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: {
      constraints: [{ kind: 'session_total_cap', value: '1000', tier: 'T2', label: 'c' }],
    },
  })
  expect(created.statusCode).toBe(200)
  const id = created.json().id

  const revoked = await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${id}/revoke`,
    headers: { ...cookie, 'content-type': 'application/json' },
  })
  expect(revoked.statusCode).toBe(200)
  expect(revoked.json().status).toBe('revoked')
})

it('blames the caller, not us, for a body it could not parse', async () => {
  // A 500 here says it is our fault and that retrying may help. Neither is true:
  // the bytes are unparseable and they will be unparseable next time too.
  const app = createApiServer({ observations: () => [], auth: authConfig() })
  apps.push(app)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/search',
    headers: { 'content-type': 'application/json' },
    payload: '{ not json',
  })
  expect(res.statusCode).toBe(400)
  expect(res.json().error.retryable).toBe(false)
  expect(res.json().error.code).toBe('INVALID_JSON')
})

it('decides what a limit is worth instead of believing the caller', async () => {
  // `Constraint.tier` arrives from whoever posted the mandate, and weakestTier
  // was reduced straight out of those claims, so this exact body used to be
  // stored and served back as T0 with nothing checked anywhere.
  const app = createApiServer({
    observations: () => [],
    auth: authConfig(),
    enforcers: AIKI_ENFORCERS_BSC_TESTNET,
  })
  apps.push(app)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: {
      constraints: [
        { kind: 'session_total_cap', value: '1000', tier: 'T0', label: 'I say this is on chain' },
      ],
    },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  // No expiry, so nothing can be held on chain at all, whatever the caller said.
  expect(body.enforcement.tier).toBe('T2')
  expect(body.policy.weakestTier).toBe('T2')
  expect(body.enforcement.limits[0].enforcedBy).toBeNull()
  expect(body.enforcement.limits[0].why).toMatch(/expiry/i)
})

it('says which limits the chain holds and which it only counts', async () => {
  const app = createApiServer({
    observations: () => [],
    auth: authConfig(),
    enforcers: AIKI_ENFORCERS_BSC_TESTNET,
  })
  apps.push(app)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: {
      constraints: [
        {
          kind: 'expiry',
          value: new Date('2030-01-01T00:00:00.000Z').toISOString(),
          tier: 'T3',
          label: 'Expires',
        },
        // Claimed T3, and genuinely unenforceable: no scope, so no amount can be
        // read out of a call. It must not be promoted, and must carry the reason.
        { kind: 'per_action_cap', value: '10', tier: 'T3', label: 'At most 10' },
      ],
    },
  })
  const { enforcement } = res.json()
  const byKind = Object.fromEntries(enforcement.limits.map((l: { kind: string }) => [l.kind, l]))
  expect(byKind.expiry.tier).toBe('T0')
  expect(byKind.expiry.enforcedBy).toBe('ExpiryEnforcer')
  expect(byKind.per_action_cap.tier).toBe('T2')
  expect(byKind.per_action_cap.why).toMatch(/before the chain can read an amount/)
  // The headline is the weakest link.
  expect(enforcement.tier).toBe('T2')
  // A testnet deployment may never present itself as anything else.
  expect(enforcement.network).toBe('testnet')
  expect(enforcement.audited).toBe(false)
})

it('counts every limit itself when no enforcers are deployed', async () => {
  const app = createApiServer({ observations: () => [], auth: authConfig() })
  apps.push(app)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: {
      constraints: [{ kind: 'session_total_cap', value: '1000', tier: 'T0', label: 'cap' }],
    },
  })
  const { enforcement } = res.json()
  expect(enforcement.tier).toBe('T2')
  expect(enforcement.network).toBeNull()
  expect(enforcement.limits[0].why).toMatch(/No enforcers are deployed/)
})
