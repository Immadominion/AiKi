import { ROOT_AUTHORITY } from '@aiki/contracts'
import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterEach, expect, it } from 'vitest'
import { InMemoryAccountStore } from '../accounts/store.js'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { compileCaveats } from '../authority/caveats.js'
import type { ChainReader } from '../authority/chain-reader.js'
import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'
import { InMemoryEvidenceStore } from '../evidence/store.js'
import { JobService } from '../jobs/service.js'
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
      categories: {},
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

it('previews what a mandate would be worth without a session or a mandate', async () => {
  // The builder shows which limits the chain holds WHILE they are being chosen,
  // so this has to answer before anyone signs in. Being asked to connect a wallet
  // before you may learn what the product enforces is the wrong way round.
  const app = createApiServer({
    observations: () => [],
    auth: authConfig(),
    enforcers: AIKI_ENFORCERS_BSC_TESTNET,
  })
  apps.push(app)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mandates/preview',
    headers: { 'content-type': 'application/json' },
    payload: {
      constraints: [
        {
          kind: 'expiry',
          value: new Date('2030-01-01T00:00:00.000Z').toISOString(),
          tier: 'T3',
          label: 'Expires',
        },
        { kind: 'per_action_cap', value: '10', tier: 'T0', label: 'At most 10' },
      ],
    },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  const byKind = Object.fromEntries(body.limits.map((l: { kind: string }) => [l.kind, l]))
  expect(byKind.expiry.tier).toBe('T0')
  // Claimed T0 by the caller, and still not enforceable: no scope to read an
  // amount from. A preview that flattered the input would be worse than none.
  expect(byKind.per_action_cap.tier).toBe('T2')
  expect(body.tier).toBe('T2')
  expect(body.network).toBe('testnet')
})

it('creates nothing when previewing', async () => {
  const jobs = new JobService()
  const app = createApiServer({
    observations: () => [],
    auth: authConfig(),
    enforcers: AIKI_ENFORCERS_BSC_TESTNET,
    jobs,
  })
  apps.push(app)
  await app.inject({
    method: 'POST',
    url: '/v1/mandates/preview',
    headers: { 'content-type': 'application/json' },
    payload: { constraints: [{ kind: 'session_total_cap', value: '1', tier: 'T0', label: 'c' }] },
  })
  // A preview that quietly authorised something would be the worst kind of
  // surprise: authority created by looking at it.
  await expect(jobs.getAuthorization('any')).rejects.toThrow()
})

it('bounds an unauthenticated preview', async () => {
  const app = createApiServer({ observations: () => [], enforcers: AIKI_ENFORCERS_BSC_TESTNET })
  apps.push(app)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mandates/preview',
    headers: { 'content-type': 'application/json' },
    payload: {
      constraints: Array.from({ length: 40 }, () => ({
        kind: 'condition',
        value: {},
        tier: 'T0',
        label: 'x',
      })),
    },
  })
  expect(res.statusCode).toBe(400)
  expect(res.json().error.code).toBe('TOO_MANY_CONSTRAINTS')
})

/** Says yes to everything, so each test isolates the refusal it is about. */
const permissiveChain = (over: Partial<ChainReader> = {}): ChainReader => ({
  ownerOf: async () => OWNER as `0x${string}`,
  isValidSignature: async () => true,
  ...over,
})

const CONSTRAINTS = [
  { kind: 'expiry', value: '2030-01-01T00:00:00.000Z', tier: 'T2', label: 'Expires' },
  {
    kind: 'contract_allowlist',
    value: ['0x55d398326f99059ff775485246999027b3197955'],
    tier: 'T2',
    label: 'USDT',
  },
  { kind: 'selector_allowlist', value: ['0xa9059cbb'], tier: 'T2', label: 'transfer' },
  {
    kind: 'asset_scope',
    value: ['0x55d398326f99059ff775485246999027b3197955'],
    tier: 'T2',
    label: 'USDT',
  },
  { kind: 'per_action_cap', value: '10000000000000000000', tier: 'T2', label: '10' },
]

async function signedApp(chain = permissiveChain()) {
  const app = createApiServer({
    observations: () => [],
    auth: authConfig(),
    enforcers: AIKI_ENFORCERS_BSC_TESTNET,
    chain,
    agentSessionKey: `0x${'ef'.repeat(20)}`,
  })
  apps.push(app)
  const created = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: { constraints: CONSTRAINTS },
  })
  const id = created.json().id
  const caveats = compileCaveats(CONSTRAINTS as never, AIKI_ENFORCERS_BSC_TESTNET).caveats
  const delegation = {
    delegate: `0x${'ef'.repeat(20)}`,
    delegator: `0x${'cd'.repeat(20)}`,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: '1',
    epoch: '0',
    signature: `0x${'11'.repeat(65)}`,
  }
  return { app, id, delegation }
}

it('files a signed delegation against the mandate it was signed for', async () => {
  const { app, id, delegation } = await signedApp()
  const res = await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${id}/delegation`,
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: { delegation },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json().delegationChainId).toBe(97)
  expect(res.json().delegator.toLowerCase()).toBe(delegation.delegator)
})

it('checks the delegation against what is stored, not against what was sent', async () => {
  // The request supplies the delegation; the constraints come from the store.
  // If both came from the request, a caller could be shown one mandate and file
  // another, and every screen would agree with them.
  const { app, id, delegation } = await signedApp()
  const cap = delegation.caveats.at(-1)
  if (!cap) throw new Error('no caveats')
  delegation.caveats[delegation.caveats.length - 1] = {
    ...cap,
    terms: `${cap.terms.slice(0, -1)}f` as `0x${string}`,
  }
  const res = await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${id}/delegation`,
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: { delegation },
  })
  expect(res.statusCode).toBe(400)
  expect(res.json().error.code).toBe('DELEGATION_CAVEAT_MISMATCH')
})

it('will not sign a mandate that has been revoked', async () => {
  // Revoke is what somebody reaches for when they want a thing to stop, so it
  // must not be possible to hand it authority afterwards.
  const { app, id, delegation } = await signedApp()
  await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${id}/revoke`,
    headers: { ...cookie, 'content-type': 'application/json' },
  })
  const res = await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${id}/delegation`,
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: { delegation },
  })
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('AUTHORIZATION_REVOKED')
})

it('refuses to sign somebody else’s mandate', async () => {
  const { app, id, delegation } = await signedApp()
  const stranger = `aiki_session=${signer.issue(`0x${'99'.repeat(20)}`, 56)}`
  const res = await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${id}/delegation`,
    headers: { cookie: stranger, 'content-type': 'application/json' },
    payload: { delegation },
  })
  // 404, not 403: telling a stranger the mandate exists is itself a disclosure.
  expect(res.statusCode).toBe(404)
})

it('says so plainly when it cannot reach a chain at all', async () => {
  const app = createApiServer({ observations: () => [], auth: authConfig() })
  apps.push(app)
  const created = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: { constraints: CONSTRAINTS },
  })
  const res = await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${created.json().id}/delegation`,
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: { delegation: {} },
  })
  expect(res.statusCode).toBe(503)
  expect(res.json().error.code).toBe('DELEGATION_UNAVAILABLE')
})

it('hands over exactly what to sign, computed by the side that checks it', async () => {
  // The alternative is a second copy of the caveat compiler in the browser, free
  // to drift from the one the API verifies against. Then a person signs what
  // their browser believed and the API rejects it, or worse accepts something
  // they were never shown.
  const { app, id, delegation } = await signedApp()
  const res = await app.inject({
    method: 'GET',
    url: `/v1/authorizations/${id}/delegation?delegator=${delegation.delegator}`,
    headers: cookie,
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.domain.chainId).toBe(97)
  expect(body.domain.name).toBe('AiKi Delegation')
  expect(body.primaryType).toBe('Delegation')
  // args are absent from the signed message and present on what gets posted
  // back, because the manager needs them and the signature must not cover them.
  expect(body.message.caveats[0].args).toBeUndefined()
  expect(body.unsigned.caveats[0].args).toBe('0x')
  // What it hands over must be what it will accept.
  const filed = await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${id}/delegation`,
    headers: { ...cookie, 'content-type': 'application/json' },
    payload: { delegation: { ...body.unsigned, signature: `0x${'11'.repeat(65)}` } },
  })
  expect(filed.statusCode).toBe(200)
})

it('will not prepare a delegation without naming the account it spends from', async () => {
  const { app, id } = await signedApp()
  const res = await app.inject({
    method: 'GET',
    url: `/v1/authorizations/${id}/delegation`,
    headers: cookie,
  })
  expect(res.statusCode).toBe(400)
  expect(res.json().error.code).toBe('DELEGATOR_REQUIRED')
})

const fakeDeployer = (address: `0x${string}`) => {
  let calls = 0
  return {
    deployer: {
      deploy: async () => {
        calls += 1
        return { address, transactionHash: `0x${'aa'.repeat(32)}` as `0x${string}` }
      },
    },
    deployments: () => calls,
  }
}

it('gives a person one account, and never a second', async () => {
  // Deploying twice would split their mandates across two accounts, and half
  // their limits would sit against the wrong one.
  const ADDRESS = `0x${'a1'.repeat(20)}` as `0x${string}`
  const fake = fakeDeployer(ADDRESS)
  const app = createApiServer({
    observations: () => [],
    auth: authConfig(),
    enforcers: AIKI_ENFORCERS_BSC_TESTNET,
    accounts: { store: new InMemoryAccountStore(), deployer: fake.deployer },
  })
  apps.push(app)

  const before = await app.inject({ method: 'GET', url: '/v1/account', headers: cookie })
  expect(before.json().address).toBeNull()

  const first = await app.inject({ method: 'POST', url: '/v1/account', headers: cookie })
  expect(first.statusCode).toBe(200)
  expect(first.json().address).toBe(ADDRESS)
  expect(first.json().created).toBe(true)

  const second = await app.inject({ method: 'POST', url: '/v1/account', headers: cookie })
  expect(second.json().address).toBe(ADDRESS)
  expect(second.json().created).toBe(false)
  // Checked before gas is spent, not after.
  expect(fake.deployments()).toBe(1)

  const after = await app.inject({ method: 'GET', url: '/v1/account', headers: cookie })
  expect(after.json().address).toBe(ADDRESS)
  expect(after.json().network).toBe('testnet')
})

it('gives two people two different accounts', async () => {
  const app = createApiServer({
    observations: () => [],
    auth: authConfig(),
    enforcers: AIKI_ENFORCERS_BSC_TESTNET,
    accounts: {
      store: new InMemoryAccountStore(),
      // Hands back a different address each time, as a real deployment would.
      deployer: {
        deploy: async (owner) => ({
          address: `0x${owner.slice(2, 4).repeat(20)}` as `0x${string}`,
          transactionHash: `0x${'bb'.repeat(32)}` as `0x${string}`,
        }),
      },
    },
  })
  apps.push(app)
  const other = `aiki_session=${signer.issue(`0x${'77'.repeat(20)}`, 56)}`
  const mine = await app.inject({ method: 'POST', url: '/v1/account', headers: cookie })
  const theirs = await app.inject({
    method: 'POST',
    url: '/v1/account',
    headers: { cookie: other },
  })
  expect(mine.json().address).not.toBe(theirs.json().address)
})

it('says so plainly when it cannot make accounts at all', async () => {
  const app = createApiServer({ observations: () => [], auth: authConfig() })
  apps.push(app)
  const res = await app.inject({ method: 'POST', url: '/v1/account', headers: cookie })
  expect(res.statusCode).toBe(503)
  expect(res.json().error.code).toBe('ACCOUNTS_UNAVAILABLE')
})

it('finds an agent by one word of a question, not only by the whole phrase', async () => {
  /*
   * Nobody types a substring. They type "venus loan guardian" and expect the
   * agent called "Venus Guardian"; requiring the whole phrase returned nothing,
   * which reads as "there are none" rather than "nothing is named that".
   */
  const store = new InMemoryEvidenceStore()
  const base = {
    predicate: 'agent.liveness_verdict',
    validAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    method: 'test',
    evidenceClass: 'B' as const,
  }
  await store.append({
    ...base,
    subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: '77' },
    value: { state: 'LIVE' },
    dedupeKey: 'venus-live',
  })
  await store.append({
    ...base,
    predicate: 'erc8004.registration_resolution',
    subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: '77' },
    value: { resolved: true, manifest: { name: 'Venus Guardian' } },
    dedupeKey: 'venus-name',
  })

  const app = createApiServer({ observations: () => store.observations })
  apps.push(app)
  const ask = async (query: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', payload: { query } })
    const body = res.json()
    if (!body.results)
      throw new Error(`search answered ${res.statusCode}: ${res.body.slice(0, 200)}`)
    return body.results.length as number
  }

  expect(await ask('venus guardian')).toBe(1)
  expect(await ask('venus loan guardian')).toBe(1)
  expect(await ask('guardian')).toBe(1)
  // Still a name match: a word that names nothing still finds nothing.
  expect(await ask('pancake')).toBe(0)
})

it('reports an agent the same way on its passport as in search', async () => {
  /*
   * These two routes disagreed in production: /v1/search returned agent 315943
   * as LIVE, named, with eight predicates, while /v1/agents/315943/passport
   * returned UNPROBED, no name and a zero score at the same instant. The
   * passport projected over the newest-10,000 page, and the reference agents'
   * continuous assessments had pushed that agent's rows out of it.
   *
   * UNPROBED is a positive claim rendered as "No probe has ever touched it", so
   * the window did not make the passport empty, it made it lie.
   */
  const store = new InMemoryEvidenceStore()
  const base = {
    validAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    method: 'test',
    evidenceClass: 'B' as const,
  }
  const subject = { type: 'agent', chainId: 56, registry: '0x8004', agentId: '315943' } as const
  await store.append({
    ...base,
    subject,
    predicate: 'agent.liveness_verdict',
    value: { state: 'LIVE' },
    dedupeKey: 'sub-live',
  })
  await store.append({
    ...base,
    subject,
    predicate: 'erc8004.registration_resolution',
    value: { resolved: true, manifest: { name: 'AiKi Venus Health Factor Guardian' } },
    dedupeKey: 'sub-name',
  })

  // Newer noise from other agents, exactly what saturated the window in
  // production. The windowed reader sees only these.
  const noise = Array.from({ length: 40 }, (_, i) => ({
    ...base,
    observedAt: '2026-02-01T00:00:00.000Z',
    subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: `n${i}` } as const,
    predicate: 'agent.liveness_verdict',
    value: { state: 'LIVE' },
    dedupeKey: `noise-${i}`,
  }))
  for (const n of noise) await store.append(n)

  const all = () => store.observations
  const app = createApiServer({
    // The window: newest rows only, which is what list(10_000) degrades to.
    observations: () => all().slice(-10),
    // The scoped reader: every row for the named agents, whatever their age.
    observationsForAgents: (ids) => all().filter((o) => ids.includes(o.subject.agentId)),
  })
  apps.push(app)

  const passport = (await app.inject({ method: 'GET', url: '/v1/agents/315943/passport' })).json()

  expect(passport.liveness).toBe('LIVE')
  expect(passport.name).toBe('AiKi Venus Health Factor Guardian')

  const compared = (
    await app.inject({
      method: 'POST',
      url: '/v1/compare',
      payload: { agentIds: ['315943', 'n0'] },
    })
  ).json()
  expect(compared.agents[0].liveness).toBe('LIVE')
})

it('says whether the books balance, without saying by how much', async () => {
  /*
   * Public and unauthenticated on purpose, so a monitor can watch it and a
   * stranger can check it. The amounts are not published: what is owed and what
   * is held are AiKi's business, and the answer to "is this venue solvent" is
   * everybody's. Amounts live in `pnpm credits:check`, which needs the database.
   */
  const app = createApiServer({
    observations: () => [],
    ledgerHealth: async () => [
      { check: 'the whole ledger nets to zero', ok: true },
      { check: 'escrow holds exactly what funded jobs are owed', ok: false },
    ],
  })
  const failing = await app.inject({ method: 'GET', url: '/v1/ledger/health' })
  // 503, because a venue whose books do not balance is not healthy, and a
  // monitor that has to parse a 200 body to find that out will not.
  expect(failing.statusCode).toBe(503)
  expect(failing.json().status).toBe('unbalanced')
  expect(JSON.stringify(failing.json())).not.toMatch(/\d{3,}/)

  const balanced = createApiServer({
    observations: () => [],
    ledgerHealth: async () => [{ check: 'the whole ledger nets to zero', ok: true }],
  })
  const ok = await balanced.inject({ method: 'GET', url: '/v1/ledger/health' })
  expect(ok.statusCode).toBe(200)
  expect(ok.json().status).toBe('balanced')
})

it('does not pretend the books are fine when it cannot read them', async () => {
  // Silence is the failure mode that let this go unnoticed for a fortnight. A
  // deployment with no ledger to check says so rather than answering "balanced".
  const app = createApiServer({ observations: () => [] })
  const reply = await app.inject({ method: 'GET', url: '/v1/ledger/health' })
  expect(reply.statusCode).toBe(503)
  expect(reply.json().status).toBe('unknown')
})
