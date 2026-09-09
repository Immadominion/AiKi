import { randomUUID } from 'node:crypto'
import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterEach, expect, it } from 'vitest'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { JobService } from '../jobs/service.js'
import { createApiServer } from './server.js'

const owner = `0x${'bc'.repeat(20)}`
const signer = new SessionSigner('authorization-retry-tests-not-a-production-secret')
const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
function setup() {
  const jobs = new JobService()
  const app = createApiServer({
    jobs,
    observations: async () => [],
    auth: {
      signer,
      nonces: new InMemoryNonceStore(),
      domain: 'aiki.test',
      secureCookies: false,
      client: createPublicClient({ chain: bsc, transport: http('http://127.0.0.1:1') }),
    },
  })
  apps.push(app)
  const payload = {
    constraints: [{ kind: 'session_total_cap', value: '1000', label: 'Total', tier: 'T2' }],
  }
  const headers = {
    cookie: `aiki_session=${signer.issue(owner, 56)}`,
    'idempotency-key': randomUUID(),
  }
  return { app, jobs, payload, headers }
}

it('persists the authorization operation across duplicate HTTP requests', async () => {
  const h = setup()
  const request = {
    method: 'POST' as const,
    url: '/v1/authorizations',
    payload: h.payload,
    headers: h.headers,
  }
  const [one, two] = await Promise.all([h.app.inject(request), h.app.inject(request)])
  expect(one.statusCode).toBe(200)
  expect(two.json().id).toBe(one.json().id)
  await h.jobs.revoke(one.json().id)
  const replay = await h.app.inject(request)
  expect(replay.json()).toMatchObject({ id: one.json().id, status: 'revoked', spent: '0' })
})

it('refuses changed terms under the same request key', async () => {
  const h = setup()
  const base = { method: 'POST' as const, url: '/v1/authorizations', headers: h.headers }
  const one = await h.app.inject({ ...base, payload: h.payload })
  const changed = await h.app.inject({
    ...base,
    payload: { constraints: [{ ...h.payload.constraints[0], value: '2000' }] },
  })
  expect(one.statusCode).toBe(200)
  expect(changed.statusCode).toBe(409)
  expect(changed.json().error.code).toBe('AUTHORIZATION_IDEMPOTENCY_CONFLICT')
})

it('validates request keys after authenticating the owner', async () => {
  const h = setup()
  const request = { method: 'POST' as const, url: '/v1/authorizations', payload: h.payload }
  expect(
    (
      await h.app.inject({
        ...request,
        headers: { 'idempotency-key': h.headers['idempotency-key'] },
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (
      await h.app.inject({
        ...request,
        headers: { ...h.headers, 'idempotency-key': 'x'.repeat(129) },
      })
    ).statusCode,
  ).toBe(400)
})
