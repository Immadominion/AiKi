import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterEach, expect, it, vi } from 'vitest'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { createApiServer } from '../http/server.js'
import { JobService } from '../jobs/service.js'
import { InMemoryJobStore } from '../jobs/store.js'
import type { WatchActivationReader } from './routes.js'
import { InMemoryWatchStore } from './store.js'

const SECRET = 'watch-routes-secret-long-enough-here'
const signer = new SessionSigner(SECRET)
const OWNER = `0x${'ab'.repeat(20)}`
const STRANGER = `0x${'cd'.repeat(20)}`
const TOKEN = `0x${'11'.repeat(20)}`
const ACCOUNT = `0x${'22'.repeat(20)}`
const MARKET = `0x${'33'.repeat(20)}`

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
  market: MARKET,
}

const activation = (): WatchActivationReader => ({
  chainId: 97,
  executorAddress: `0x${'44'.repeat(20)}`,
  verifyMandate: vi.fn(async () => ({ ready: true as const })),
  snapshot: vi.fn(async (account) => ({
    account,
    observedAt: new Date().toISOString(),
    controllerLiquidity: 0n,
    controllerShortfall: 0n,
    markets: [
      {
        vToken: MARKET as `0x${string}`,
        collateralFactor: 0n,
        liquidationThreshold: 0n,
        vTokenBalance: 0n,
        borrowBalance: 1n,
        exchangeRate: 10n ** 18n,
        underlyingPrice: 10n ** 18n,
      },
    ],
  })),
  underlying: vi.fn(async () => TOKEN as `0x${string}`),
})

async function harness(
  options: {
    signed?: boolean
    capped?: boolean
    delegator?: string
    delegate?: string
    delegationChainId?: number
    activation?: WatchActivationReader | null
  } = {},
) {
  const jobs = new JobService(new InMemoryJobStore())
  const watches = new InMemoryWatchStore()
  const app = createApiServer({
    // The evidence surface is irrelevant here and covered by server.test.ts.
    observations: () => [],
    jobs,
    watches,
    ...(options.activation === null ? {} : { watchActivation: options.activation ?? activation() }),
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
        delegate: options.delegate ?? `0x${'44'.repeat(20)}`,
        delegator: options.delegator ?? ACCOUNT,
        authority: `0x${'ff'.repeat(32)}`,
        caveats: [],
        salt: '1',
        epoch: '0',
        signature: `0x${'66'.repeat(65)}`,
      } as never,
      chainId: options.delegationChainId ?? 97,
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

it('does not activate a watch while its mandate has an unresolved transaction', async () => {
  const reader = activation()
  const { app, jobs, job, watches } = await harness({ activation: reader })
  const claim = await jobs.beginExecution(job.id, 97)
  const hash = `0x${'ab'.repeat(32)}` as const
  await jobs.recordExecutionHash(claim.attempt.id, hash)
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('WATCH_EXECUTION_UNCONFIRMED')
  expect(response.json().error.message).toContain(hash)
  expect(await watches.get(job.id)).toBeNull()
  expect(reader.snapshot).not.toHaveBeenCalled()
})

it('starts a mainnet watch when the reader and signed mandate both use chain56', async () => {
  const reader = { ...activation(), chainId: 56 }
  const { app, job, watches } = await harness({ activation: reader, delegationChainId: 56 })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: { ...START, chainId: 56 },
  })
  expect(response.statusCode).toBe(201)
  expect((await watches.get(job.id))?.chainId).toBe(56)
})

it.each([56, 97])(
  'refuses a mandate for a different executor before chain reads on chain%d',
  async (chainId) => {
    const reader = { ...activation(), chainId }
    const { app, job, watches } = await harness({
      activation: reader,
      delegationChainId: chainId,
      delegate: `0x${'55'.repeat(20)}`,
    })
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/watch`,
      headers: cookie,
      payload: { ...START, chainId },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('WATCH_EXECUTOR_MISMATCH')
    expect(await watches.get(job.id)).toBeNull()
    expect(reader.snapshot).not.toHaveBeenCalled()
    expect(reader.underlying).not.toHaveBeenCalled()
  },
)

it('does not activate a watch when its execution key address is unavailable', async () => {
  const reader = activation()
  delete reader.executorAddress
  const { app, job, watches } = await harness({ activation: reader })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(503)
  expect(response.json().error.code).toBe('WATCH_UNAVAILABLE')
  expect(await watches.get(job.id)).toBeNull()
  expect(reader.snapshot).not.toHaveBeenCalled()
})

it('compares the signed and configured executor without checksum-case differences', async () => {
  const reader = { ...activation(), executorAddress: `0x${'aB'.repeat(20)}` as `0x${string}` }
  const { app, job } = await harness({ activation: reader, delegate: `0x${'ab'.repeat(20)}` })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(201)
})

it.each([false, true])(
  'refuses an incompatible signed mandate (retryable: %s)',
  async (retryable) => {
    const reader = activation()
    reader.verifyMandate = vi.fn(async () => ({
      ready: false as const,
      reason: retryable
        ? 'Mandate verification is temporarily unavailable.'
        : 'Sign a new mandate for this manager.',
      retryable,
    }))
    const { app, job, jobs, watches } = await harness({ activation: reader })
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/watch`,
      headers: cookie,
      payload: START,
    })
    expect(response.statusCode).toBe(retryable ? 503 : 409)
    expect(response.json().error.code).toBe('WATCH_MANDATE_NOT_READY')
    expect(reader.verifyMandate).toHaveBeenCalledWith(
      await jobs.getAuthorization(job.authorizationId),
    )
    expect(await watches.get(job.id)).toBeNull()
    expect(reader.snapshot).not.toHaveBeenCalled()
    expect(reader.underlying).not.toHaveBeenCalled()
  },
)

it('requires signed mandate verification before creating a watch', async () => {
  const reader = activation()
  delete reader.verifyMandate
  const { app, job, watches } = await harness({ activation: reader })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(503)
  expect(response.json().error.code).toBe('WATCH_UNAVAILABLE')
  expect(await watches.get(job.id)).toBeNull()
  expect(reader.snapshot).not.toHaveBeenCalled()
})

it('sanitizes unexpected mandate verifier failures without starting a watch', async () => {
  const reader = activation()
  reader.verifyMandate = vi.fn(async () => {
    throw new Error('private-rpc-credential-fixture')
  })
  const { app, job, watches } = await harness({ activation: reader })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(503)
  expect(response.json().error.code).toBe('WATCH_MANDATE_NOT_READY')
  expect(response.body).not.toContain('private-rpc-credential-fixture')
  expect(await watches.get(job.id)).toBeNull()
  expect(reader.snapshot).not.toHaveBeenCalled()
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

it('refuses a mandate that does not permit repaying', async () => {
  // Otherwise the chain refuses every pass forever, and from the outside it
  // looks like an agent that just never does anything.
  const jobs = new JobService(new InMemoryJobStore())
  const watches = new InMemoryWatchStore()
  const app = createApiServer({
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
    [
      { kind: 'session_total_cap', value: '1000', tier: 'T0', label: 'cap' },
      // transfer only, which cannot repay a loan.
      { kind: 'selector_allowlist', value: ['0xa9059cbb'], tier: 'T0', label: 'selectors' },
    ],
    OWNER,
  )
  await jobs.attachDelegation(authorization.id, {
    delegation: {
      delegate: `0x${'44'.repeat(20)}`,
      delegator: ACCOUNT,
      authority: `0x${'ff'.repeat(32)}`,
      caveats: [],
      salt: '1',
      epoch: '0',
      signature: `0x${'66'.repeat(65)}`,
    } as never,
    chainId: 97,
  })
  const job = await jobs.createJob(authorization.id, `k-${Math.random()}`)
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: START,
  })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('WATCH_SELECTOR_NOT_ALLOWED')
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

it('does not accept mainnet watches when only testnet execution exists', async () => {
  const reader = activation()
  const { app, job, watches } = await harness({ activation: reader })
  const response = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${job.id}/watch`,
    headers: cookie,
    payload: { ...START, chainId: 56 },
  })
  expect(response.statusCode).toBe(400)
  expect(response.json().error.code).toBe('WATCH_UNSUPPORTED_CHAIN')
  expect(reader.snapshot).not.toHaveBeenCalled()
  expect(await watches.get(job.id)).toBeNull()
})

it('requires the same account and chain as the signed delegation before reading or creating a watch', async () => {
  for (const options of [
    { delegator: STRANGER, code: 'WATCH_ACCOUNT_MISMATCH' },
    { delegationChainId: 56, code: 'WATCH_CHAIN_MISMATCH' },
  ]) {
    const reader = activation()
    const { app, job, watches } = await harness({ ...options, activation: reader })
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/watch`,
      headers: cookie,
      payload: START,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe(options.code)
    expect(reader.snapshot).not.toHaveBeenCalled()
    expect(await watches.get(job.id)).toBeNull()
  }
})

it('refuses activation without a configured reader or when chain reads fail', async () => {
  const failed = activation()
  vi.mocked(failed.snapshot).mockRejectedValue(new Error('private RPC credentials must not leak'))
  for (const reader of [null, failed]) {
    const { app, job, watches } = await harness({ activation: reader })
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/watch`,
      headers: cookie,
      payload: START,
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe(
      reader ? 'WATCH_POSITION_UNAVAILABLE' : 'WATCH_UNAVAILABLE',
    )
    expect(response.body).not.toContain('private RPC')
    expect(await watches.get(job.id)).toBeNull()
  }
})

it('requires actual debt in the selected Venus market, not another account or market', async () => {
  for (const change of ['absent', 'no-debt', 'wrong-account'] as const) {
    const reader = activation()
    const snapshot = await reader.snapshot(ACCOUNT as `0x${string}`)
    if (change === 'absent') snapshot.markets = []
    if (change === 'no-debt')
      snapshot.markets = snapshot.markets.map((position) => ({ ...position, borrowBalance: 0n }))
    if (change === 'wrong-account') snapshot.account = STRANGER as `0x${string}`
    vi.mocked(reader.snapshot).mockResolvedValue(snapshot)
    const { app, job, watches } = await harness({ activation: reader })
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/watch`,
      headers: cookie,
      payload: START,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe(
      change === 'wrong-account' ? 'WATCH_ACCOUNT_MISMATCH' : 'WATCH_NO_DEBT',
    )
    expect(reader.underlying).not.toHaveBeenCalled()
    expect(await watches.get(job.id)).toBeNull()
  }
})

it('binds the repayment asset to the selected market underlying and fails closed on unavailable token reads', async () => {
  for (const failure of ['mismatch', 'unavailable'] as const) {
    const reader = activation()
    if (failure === 'mismatch')
      vi.mocked(reader.underlying).mockResolvedValue(STRANGER as `0x${string}`)
    else vi.mocked(reader.underlying).mockRejectedValue(new Error('upstream internals'))
    const { app, job, watches } = await harness({ activation: reader })
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/watch`,
      headers: cookie,
      payload: START,
    })
    expect(response.statusCode).toBe(failure === 'mismatch' ? 409 : 503)
    expect(response.json().error.code).toBe(
      failure === 'mismatch' ? 'WATCH_ASSET_MISMATCH' : 'WATCH_POSITION_UNAVAILABLE',
    )
    expect(reader.underlying).toHaveBeenCalledWith(MARKET)
    expect(await watches.get(job.id)).toBeNull()
  }
})
