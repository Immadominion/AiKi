import { afterEach, expect, it, vi } from 'vitest'
import { MUTATING, runTool, TOOLS } from './tools.js'

const owner = `0x${'12'.repeat(20)}`
const accountAddress = `0x${'34'.repeat(20)}`
const manager = `0x${'56'.repeat(20)}`
const authorizationId = '12345678-1234-4123-8123-123456789012'
const ctx = {
  baseUrl: 'https://api.example',
  cookie: 'local-test-session',
  sessionAddress: owner,
}
const limits = { per_action_usdt: 1.000001, total_usdt: 10, expires_in_days: 30 }
const rails = [
  {
    chainId: 56,
    network: 'mainnet',
    asset: '0x55d398326f99059ff775485246999027b3197955',
    market: '0xfd5840cd36d94d7229439859c0112a4185bc0255',
    perAction: '1000001000000000000',
    total: '10000000000000000000',
  },
  {
    chainId: 97,
    network: 'testnet',
    asset: '0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c',
    market: '0xb7526572ffe56ab9d7489838bf2e18e3323b441a',
    perAction: '1000001',
    total: '10000000',
  },
] as const

interface RecordedRequest {
  path: string
  method: string
  body: Record<string, unknown> | undefined
}

function harness(
  options: {
    chainId?: 56 | 97
    metadata?: unknown
    metadataStatus?: number
    account?: unknown
    accountStatus?: number
    deployed?: unknown
    deployStatus?: number
  } = {},
) {
  const chainId = options.chainId ?? 56
  const rail = chainId === 56 ? rails[0] : rails[1]
  const requests: RecordedRequest[] = []
  const metadata = {
    configured: true,
    chainId,
    network: chainId === 56 ? 'mainnet' : 'testnet',
    audited: false,
    manager,
    guardian: {
      chainId,
      network: rail.network,
      asset: rail.asset,
      market: rail.market,
      decimals: chainId === 56 ? 18 : 6,
      repayBorrowSelector: '0x0e752702',
    },
  }
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    requests.push({
      path,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/v1/execution/network' && method === 'GET')
      return respond(
        options.metadata === undefined ? metadata : options.metadata,
        options.metadataStatus,
      )
    if (path === '/v1/account' && method === 'GET')
      return respond(
        options.account === undefined ? { address: accountAddress, chainId } : options.account,
        options.accountStatus,
      )
    if (path === '/v1/account' && method === 'POST')
      return respond(
        options.deployed === undefined ? { address: accountAddress, chainId } : options.deployed,
        options.deployStatus,
      )
    if (path === '/v1/mandates/preview' && method === 'POST')
      return respond({ network: metadata.network, limits: requests.at(-1)?.body?.constraints })
    if (path === '/v1/authorizations' && method === 'POST')
      return respond({
        id: authorizationId,
        owner,
        constraints: requests.at(-1)?.body?.constraints,
      })
    if (path === '/v1/jobs/job-local-test/watch' && method === 'POST')
      return respond({ status: 'active', ...requests.at(-1)?.body })
    throw new Error(`Unexpected mocked request: ${method} ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  const posted = (path: string) =>
    requests.find((request) => request.path === path && request.method === 'POST')?.body
  return { requests, fetch, posted, metadata }
}

afterEach(() => vi.unstubAllGlobals())

it.each(rails)(
  'previews exact $network constraints without an account or mutation',
  async (rail) => {
    const h = harness({ chainId: rail.chainId })
    const result = await runTool(ctx, 'preview_limits', limits)
    expect(result.ok).toBe(true)
    expect(h.requests.map(({ path }) => path)).toEqual([
      '/v1/execution/network',
      '/v1/mandates/preview',
    ])
    const constraints = h.posted('/v1/mandates/preview')?.constraints as {
      kind: string
      value: string | string[]
    }[]
    expect(constraints).toHaveLength(6)
    expect(constraints.find((c) => c.kind === 'per_action_cap')?.value).toBe(rail.perAction)
    expect(constraints.find((c) => c.kind === 'session_total_cap')?.value).toBe(rail.total)
    expect(String(constraints.find((c) => c.kind === 'asset_scope')?.value).toLowerCase()).toBe(
      rail.asset,
    )
    expect(
      String(constraints.find((c) => c.kind === 'contract_allowlist')?.value).toLowerCase(),
    ).toBe(rail.market)
    expect(constraints.find((c) => c.kind === 'selector_allowlist')?.value).toEqual(['0x0e752702'])
  },
)

it.each(rails)(
  'creates a $network mandate only after checking the account network',
  async (rail) => {
    const h = harness({ chainId: rail.chainId, account: { address: null, chainId: rail.chainId } })
    const result = await runTool(ctx, 'create_mandate', limits)
    expect(result.ok).toBe(true)
    expect(result.action).toEqual({
      kind: 'sign_mandate',
      authorizationId,
      chainId: rail.chainId,
      account: accountAddress,
      manager,
    })
    expect(h.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/execution/network',
      'GET /v1/account',
      'POST /v1/account',
      'POST /v1/authorizations',
    ])
    expect(h.posted('/v1/authorizations')?.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'per_action_cap', value: rail.perAction }),
        expect.objectContaining({ kind: 'session_total_cap', value: rail.total }),
      ]),
    )
  },
)

it.each(rails)('starts a $network watch using only runtime execution metadata', async (rail) => {
  const h = harness({ chainId: rail.chainId })
  const result = await runTool(ctx, 'watch_position', {
    job_id: 'job-local-test',
    minimum_health_factor: '1.50',
    // Neither conversation data nor a model-invented argument selects the rail.
    chainId: rail.chainId === 56 ? 97 : 56,
    asset: owner,
    market: owner,
    depositChainId: rail.chainId === 56 ? 97 : 56,
  })
  expect(result.ok).toBe(true)
  const posted = h.posted('/v1/jobs/job-local-test/watch')
  expect(posted).toMatchObject({
    account: accountAddress,
    chainId: rail.chainId,
    minimumHealthFactor: '1.50',
  })
  expect(String(posted?.asset).toLowerCase()).toBe(rail.asset)
  expect(String(posted?.market).toLowerCase()).toBe(rail.market)
  expect(h.requests.map(({ path }) => path)).toEqual([
    '/v1/execution/network',
    '/v1/account',
    '/v1/jobs/job-local-test/watch',
  ])
})

it('re-reads metadata for each invocation instead of retaining a previous network', async () => {
  const h = harness()
  await runTool(ctx, 'preview_limits', limits)
  h.fetch.mockImplementationOnce(
    async () => new Response(JSON.stringify({ configured: false }), { status: 503 }),
  )
  const result = await runTool(ctx, 'create_mandate', limits)
  expect(result.ok).toBe(false)
  expect(h.fetch).toHaveBeenCalledTimes(3)
  expect(h.posted('/v1/account')).toBeUndefined()
  expect(h.posted('/v1/authorizations')).toBeUndefined()
})

it('uses the newly selected execution rail on a later preview', async () => {
  const h = harness()
  await runTool(ctx, 'preview_limits', limits)
  h.fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ...h.metadata,
        chainId: 97,
        network: 'testnet',
        guardian: {
          ...h.metadata.guardian,
          chainId: 97,
          network: 'testnet',
          asset: rails[1].asset,
          market: rails[1].market,
          decimals: 6,
        },
      }),
    ),
  )
  expect((await runTool(ctx, 'preview_limits', limits)).ok).toBe(true)
  expect(h.requests.at(-1)?.body?.constraints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'per_action_cap', value: rails[1].perAction }),
      expect.objectContaining({ kind: 'asset_scope', value: [rails[1].asset] }),
    ]),
  )
  expect(h.fetch).toHaveBeenCalledTimes(4)
})

it.each(['transport', 'invalid JSON'])(
  'sanitizes a metadata %s failure without proceeding',
  async (failure) => {
    const h = harness()
    if (failure === 'transport')
      h.fetch.mockRejectedValueOnce(new Error('https://private-rpc/secret-key'))
    else h.fetch.mockResolvedValueOnce(new Response('https://private-rpc/secret-key'))
    const result = await runTool(ctx, 'create_mandate', limits)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.posted('/v1/authorizations')).toBeUndefined()
  },
)

it.each(['preview_limits', 'create_mandate', 'watch_position'])(
  '%s returns a network HTTP refusal before any account or mutation',
  async (tool) => {
    const error = {
      error: { code: 'EXECUTION_UNAVAILABLE', message: 'Execution is not configured.' },
    }
    const h = harness({ metadata: error, metadataStatus: 503 })
    expect(await runTool(ctx, tool, { ...limits, job_id: 'job-local-test' })).toEqual({
      ok: false,
      body: error,
    })
    expect(h.requests).toHaveLength(1)
  },
)

it.each([
  null,
  {},
  { configured: false },
  { configured: true, chainId: 1, network: 'mainnet', audited: false, manager },
  { configured: true, chainId: 56, network: 'testnet', audited: false, manager },
  { configured: true, chainId: '56', network: 'mainnet', audited: false, manager },
  { configured: true, chainId: 56, network: 'mainnet', audited: 'yes', manager },
  { configured: true, chainId: 56, network: 'mainnet', audited: false, manager: 'invalid' },
])(
  'refuses malformed or unsupported metadata without account side effects: %j',
  async (metadata) => {
    const h = harness({ metadata })
    const result = await runTool(ctx, 'create_mandate', limits)
    expect(result.ok).toBe(false)
    expect(h.requests).toHaveLength(1)
  },
)

it.each([
  { per_action_usdt: 0 },
  { per_action_usdt: -1 },
  { per_action_usdt: Number.NaN },
  { total_usdt: Number.POSITIVE_INFINITY },
  { per_action_usdt: 11 },
  { total_usdt: Number.MAX_SAFE_INTEGER + 1 },
  { per_action_usdt: '1' },
  { per_action_usdt: true },
  { expires_in_days: 0 },
  { expires_in_days: 366 },
  { expires_in_days: 1.5 },
  { expires_in_days: '30' },
])('rejects invalid limits before account deployment: %j', async (invalid) => {
  const h = harness({ account: { address: null, chainId: 56 } })
  const result = await runTool(ctx, 'create_mandate', { ...limits, ...invalid })
  expect(result.ok).toBe(false)
  expect(h.requests.every((request) => request.method === 'GET')).toBe(true)
  expect(h.requests.some((request) => request.path === '/v1/account')).toBe(false)
})

it('rejects excess testnet precision instead of rounding a user limit upward', async () => {
  const h = harness({ chainId: 97, account: { address: null, chainId: 97 } })
  const result = await runTool(ctx, 'create_mandate', { ...limits, per_action_usdt: 1.0000009 })
  expect(result.ok).toBe(false)
  expect(h.posted('/v1/account')).toBeUndefined()
  expect(h.posted('/v1/authorizations')).toBeUndefined()
})

it.each(['create_mandate', 'watch_position'])(
  '%s preserves account read refusals and never deploys or proceeds',
  async (tool) => {
    const error = { error: { code: 'ACCOUNTS_UNAVAILABLE', message: 'Accounts are unavailable.' } }
    const h = harness({ account: error, accountStatus: 503 })
    expect(await runTool(ctx, tool, { ...limits, job_id: 'job-local-test' })).toEqual({
      ok: false,
      body: error,
    })
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true)
  },
)

it.each([
  { address: accountAddress, chainId: 97 },
  { address: accountAddress, chainId: '56' },
  { address: accountAddress },
  { address: 'invalid', chainId: 56 },
  { address: `0x${'0'.repeat(40)}`, chainId: 56 },
  { chainId: 56 },
  null,
])('rejects an unverified account before authorization or watch creation: %j', async (account) => {
  const h = harness({ account })
  for (const tool of ['create_mandate', 'watch_position']) {
    expect((await runTool(ctx, tool, { ...limits, job_id: 'job-local-test' })).ok).toBe(false)
  }
  expect(h.requests.every((request) => request.method === 'GET')).toBe(true)
})

it('does not create a watch or account when no account exists', async () => {
  const h = harness({ account: { address: null, chainId: 56 } })
  expect((await runTool(ctx, 'watch_position', { job_id: 'job-local-test' })).ok).toBe(false)
  expect(h.requests.every((request) => request.method === 'GET')).toBe(true)
})

it('preserves a deployment refusal and does not create a dangling mandate', async () => {
  const error = { error: { code: 'DEPLOYMENT_REFUSED', message: 'Account could not be deployed.' } }
  const h = harness({ account: { address: null, chainId: 56 }, deployed: error, deployStatus: 503 })
  expect(await runTool(ctx, 'create_mandate', limits)).toEqual({ ok: false, body: error })
  expect(h.posted('/v1/authorizations')).toBeUndefined()
})

it.each(['GET', 'POST'])(
  'sanitizes a lost %s account response without authorizing',
  async (method) => {
    const h = harness({ account: { address: null, chainId: 56 } })
    const original = h.fetch.getMockImplementation()
    if (!original) throw new Error('Missing mocked fetch implementation')
    h.fetch.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === '/v1/account' && (init?.method ?? 'GET') === method)
        throw new Error('https://private-rpc/secret-key')
      return original(input, init)
    })
    const result = await runTool(ctx, 'create_mandate', limits)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(JSON.stringify(result)).not.toContain('nothing was created')
    expect(h.posted('/v1/authorizations')).toBeUndefined()
  },
)

it.each([
  { address: accountAddress, chainId: 97 },
  { address: accountAddress },
  { address: null, chainId: 56 },
  { address: 'invalid', chainId: 56 },
])('verifies the deployed account before creating a mandate: %j', async (deployed) => {
  const h = harness({ account: { address: null, chainId: 56 }, deployed })
  expect((await runTool(ctx, 'create_mandate', limits)).ok).toBe(false)
  expect(h.posted('/v1/authorizations')).toBeUndefined()
})

it('keeps marketplace points mandates independent of execution configuration', async () => {
  const h = harness({ metadata: { configured: false }, metadataStatus: 503 })
  expect((await runTool(ctx, 'create_spending_mandate', { total: 100, per_task: 20 })).ok).toBe(
    true,
  )
  expect(h.requests.map(({ path }) => path)).toEqual(['/v1/authorizations'])
  expect(h.posted('/v1/authorizations')?.constraints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'session_total_cap', label: '100 points of work in total' }),
    ]),
  )
  expect(MUTATING.has('create_mandate')).toBe(true)
  expect(MUTATING.has('watch_position')).toBe(true)
  expect(MUTATING.has('preview_limits')).toBe(false)
  expect(TOOLS.find((tool) => tool.name === 'create_mandate')?.description).toContain(
    'does NOT sign',
  )
})
