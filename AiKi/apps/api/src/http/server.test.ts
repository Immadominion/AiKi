import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterEach, expect, it } from 'vitest'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
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
  expect(
    (await app.inject({ method: 'POST', url: '/v1/quotes', payload: { agentId: 'venus-1' } }))
      .statusCode,
  ).toBe(200)
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
  const arena = await app.inject({
    method: 'POST',
    url: '/v1/arena/runs',
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
