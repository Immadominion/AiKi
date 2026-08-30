import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterEach, expect, it } from 'vitest'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { createApiServer } from '../http/server.js'
import { JobService } from '../jobs/service.js'
import { InMemoryJobStore } from '../jobs/store.js'
import { InMemoryWatchStore } from './store.js'

const SECRET = 'watch-routes-secret-long-enough-here'
const signer = new SessionSigner(SECRET)
const OWNER = `0x${'ab'.repeat(20)}`
const STRANGER = `0x${'cd'.repeat(20)}`
const TOKEN = `0x${'11'.repeat(20)}`
const ACCOUNT = `0x${'22'.repeat(20)}`

const cookie = {
  cookie: `aiki_session=${signer.issue(OWNER, 56)}`,
  'content-type': 'application/json',
}
const strangerCookie = {
  cookie: `aiki_session=${signer.issue(STRANGER, 56)}`,
  'content-type': 'application/json',
}

const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const START = {
  account: ACCOUNT,
  chainId: 97,
  minimumHealthFactor: '1.4',
  asset: TOKEN,
  repayTo: TOKEN,
}

async function harness(options: { signed?: boolean; capped?: boolean } = {}) {
  const jobs = new JobService(new InMemoryJobStore())
  const watches = new InMemoryWatchStore()
  const app = createApiServer({
    // The evidence surface is irrelevant here and covered by server.test.ts.
    observations: () => [],
    jobs,
    watches,
    auth: {
      signer,
      nonces: new InMemoryNonceStore(),
      domain: 'aiki.test',
      secureCookies: false,
      client: createPublicClient({ chain: bsc, transport: http('http://127.0.0.1:1') }),
    },
  })
  apps.push(app)

  const authorization = await jobs.authorize(
    options.capped === false
      ? [
          {
            kind: 'expiry',
            value: new Date(Date.now() + 3_600_000).toISOString(),
            tier: 'T2',
            label: 'expiry',
          },
        ]
      : [{ kind: 'session_total_cap', value: '1000', tier: 'T0', label: 'cap' }],
    OWNER,
  )
  if (options.signed !== false)
    await jobs.attachDelegation(authorization.id, {
      delegation: {
        delegate: `0x${'44'.repeat(20)}`,
        delegator: `0x${'55'.repeat(20)}`,
        authority: `0x${'ff'.repeat(32)}`,
        caveats: [],
        salt: '1',
        epoch: '0',
        signature: `0x${'66'.repeat(65)}`,
      } as never,
      chainId: 97,
    })
  const job = await jobs.createJob(authorization.id, `k-${Math.random()}`)
  return { app, jobs, watches, job }
}

it('starts a watch on a signed, capped mandate', async () => {
  const { app, job, watches } = await harness()
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(201)
  expect(response.json().minimumHealthFactor).toBe('1.4')
  expect((await watches.get(job.id))?.status).toBe('active')
})

it('refuses to watch under a mandate nobody signed', async () => {
  // The refusal that makes the whole loop defensible: while the user is away,
  // the chain has to be the thing holding the limit, not AiKi's own bookkeeping.
  const { app, job, watches } = await harness({ signed: false })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('WATCH_UNSIGNED')
  expect(await watches.get(job.id)).toBeNull()
})

it('refuses to watch under a mandate with no spending limit', async () => {
  const { app, job } = await harness({ capped: false })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('WATCH_UNCAPPED')
})

it('will not let a stranger watch, read, or stop somebody else’s job', async () => {
  const { app, job } = await harness()
  for (const [method, url] of [
    ['POST', `/v1/jobs/${job.id}/watch`],
    ['GET', `/v1/jobs/${job.id}/watch`],
    ['POST', `/v1/jobs/${job.id}/watch/stop`],
  ] as const) {
    const response = await app.inject({ method, url, headers: strangerCookie, payload: START })
    expect(response.statusCode).toBe(404)
  }
})

it('rejects a health factor that is already liquidatable or absurd', async () => {
  const { app, job } = await harness()
  for (const value of ['0.9', '50', 'soon', '']) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/watch`,
      headers: cookie,
      payload: { ...START, minimumHealthFactor: value },
    })
    expect(response.statusCode).toBe(400)
  }
})

it('refuses a chain where AiKi cannot read Venus', async () => {
  const { app, job } = await harness()
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: { ...START, chainId: 1 },
  })
  expect(response.statusCode).toBe(400)
  expect(response.json().error.code).toBe('WATCH_UNSUPPORTED_CHAIN')
})

it('will not start a second watch on the same job', async () => {
  // Two watches on one job would race each other through the same cap.
  const { app, job } = await harness()
  await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  const again = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(again.statusCode).toBe(409)
})

it('reports what is left to spend alongside the watch', async () => {
  const { app, job } = await harness()
  await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  const response = await app.inject({
    method: 'GET',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().remaining).toBe('1000')
})

it('stops a watch when the owner asks', async () => {
  const { app, job, watches } = await harness()
  await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch/stop`,
    headers: cookie,
  })
  expect(response.statusCode).toBe(200)
  expect((await watches.get(job.id))?.status).toBe('stopped')
})
