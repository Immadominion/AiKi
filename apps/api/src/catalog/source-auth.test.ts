import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { registerCatalogRoutes } from './routes.js'
import { CatalogService, catalogSourceLimits } from './service.js'
import { type CatalogFetch, publicFetch } from './transport.js'

vi.mock('./transport.js', async (original) => ({
  ...(await original<typeof import('./transport.js')>()),
  publicFetch: vi.fn(),
}))

const testKey = 'catalog-test-only-key'
const wallet = '0x1111111111111111111111111111111111111111'
const raw = (a2a = false) => ({
  token_id: '45650',
  chain_id: 56,
  contract_address: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  owner_address: '0xda977767452c5dd021624511f14df67b6c9c2c1b',
  name: 'Catalog auth fixture',
  description: 'Test provider',
  supported_protocols: [a2a ? 'A2A' : 'MCP'],
  services: a2a
    ? { a2a: { endpoint: 'https://provider.example/a2a' } }
    : { mcp: { endpoint: 'https://erc8004.heyanon.ai/mcp/v3pools' } },
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function fixture(a2a = false) {
  const calls: Array<{ url: URL; headers: Headers; method: string }> = []
  const fetcher: CatalogFetch = async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers), method: init.method ?? 'GET' })
    if (url.origin === 'https://api.8004scan.io')
      return json(
        url.pathname.endsWith('/agents')
          ? { items: [raw(a2a)], total: 1, has_more: false, next_cursor: null }
          : raw(a2a),
      )
    const request = JSON.parse(String(init.body))
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result =
      request.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
        : request.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'getDexInfo',
                  inputSchema: {
                    type: 'object',
                    properties: { chainName: { type: 'string', enum: ['bsc'] } },
                    required: ['chainName'],
                    additionalProperties: false,
                  },
                },
              ],
            }
          : { content: [{ type: 'text', text: 'Public BNB Chain DEX information' }] }
    return json({ jsonrpc: '2.0', id: request.id, result })
  }
  return { calls, fetcher }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(publicFetch).mockReset()
})

it('sends the configured key only to the official source, never MCP discovery or reads', async () => {
  const h = fixture()
  const service = new CatalogService({ fetcher: h.fetcher, apiKey: testKey })
  await service.list({})
  await service.detail('45650')
  expect((await service.capabilities('45650')).status).toBe('available')
  expect((await service.read('45650', 'getDexInfo', { chainName: 'bsc' }, wallet)).status).toBe(
    'completed',
  )
  const source = h.calls.filter((call) => call.method === 'GET')
  expect(source).toHaveLength(2)
  for (const call of source) {
    expect(call.url.origin).toBe('https://api.8004scan.io')
    expect(call.url.pathname.startsWith('/api/v1/agents')).toBe(true)
    expect(call.url.href).not.toContain(testKey)
    expect(call.headers.get('x-api-key')).toBe(testKey)
  }
  const provider = h.calls.filter((call) => call.method === 'POST')
  expect(provider.length).toBeGreaterThan(0)
  for (const call of provider) {
    expect(call.headers.has('x-api-key')).toBe(false)
    expect(call.headers.has('x-access-token')).toBe(false)
    expect(call.headers.has('authorization')).toBe(false)
    expect(call.headers.has('cookie')).toBe(false)
    expect(call.url.href).not.toContain(testKey)
  }
})

it('does not send a source credential to a listed A2A provider', async () => {
  const h = fixture(true)
  const service = new CatalogService({ fetcher: h.fetcher, apiKey: testKey })
  expect((await service.capabilities('45650')).status).toBe('unsupported')
  expect(h.calls).toHaveLength(1)
  expect(h.calls[0]?.url.origin).toBe('https://api.8004scan.io')
})

it.each([undefined, '', '   '])(
  'keeps anonymous requests credential-free when key is %s',
  async (key) => {
    const h = fixture()
    const service = new CatalogService({
      fetcher: h.fetcher,
      ...(key !== undefined ? { apiKey: key } : {}),
    })
    await service.detail('45650')
    expect(h.calls[0]?.headers.has('x-api-key')).toBe(false)
  },
)

it('default route composition reads the server key without returning it to the browser', async () => {
  vi.stubEnv('EIGHT004SCAN_API_KEY', testKey)
  const h = fixture()
  vi.mocked(publicFetch).mockImplementation(h.fetcher)
  const app = Fastify()
  registerCatalogRoutes(app)
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/catalog/agents' })
    expect(response.statusCode).toBe(200)
    expect(h.calls[0]?.headers.get('x-api-key')).toBe(testKey)
    expect(response.body).not.toContain(testKey)
    expect(JSON.stringify(response.headers)).not.toContain(testKey)
  } finally {
    await app.close()
  }
})

it('uses conservative defaults and requires a key for explicit quota increases', () => {
  expect(catalogSourceLimits({})).toEqual({ perMinute: 24, perDay: 900 })
  expect(catalogSourceLimits({ apiKey: testKey })).toEqual({ perMinute: 24, perDay: 900 })
  const elevated = { sourceRequestsPerMinute: '120', sourceRequestsPerDay: '20000' }
  expect(catalogSourceLimits(elevated)).toEqual({ perMinute: 24, perDay: 900 })
  expect(catalogSourceLimits({ ...elevated, apiKey: '   ' })).toEqual({
    perMinute: 24,
    perDay: 900,
  })
  expect(catalogSourceLimits({ ...elevated, apiKey: testKey })).toEqual({
    perMinute: 120,
    perDay: 20000,
  })
  expect(catalogSourceLimits({ sourceRequestsPerMinute: 5, sourceRequestsPerDay: 100 })).toEqual({
    perMinute: 5,
    perDay: 100,
  })
})

it('rejects malformed, unsafe and over-ceiling quota settings independently', () => {
  for (const value of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '',
    ' ',
    '1e2',
    '12.0',
    'Infinity',
    '120requests',
  ]) {
    expect(
      catalogSourceLimits({
        apiKey: testKey,
        sourceRequestsPerMinute: value,
        sourceRequestsPerDay: value,
      }),
    ).toEqual({ perMinute: 24, perDay: 900 })
  }
  expect(
    catalogSourceLimits({
      apiKey: testKey,
      sourceRequestsPerMinute: 3001,
      sourceRequestsPerDay: '20000',
    }),
  ).toEqual({ perMinute: 24, perDay: 20000 })
  expect(
    catalogSourceLimits({
      apiKey: testKey,
      sourceRequestsPerMinute: '120',
      sourceRequestsPerDay: 3000001,
    }),
  ).toEqual({ perMinute: 120, perDay: 900 })
})

it('enforces an explicit minute budget and keeps cache hits outside upstream accounting', async () => {
  let now = 0
  const h = fixture()
  const service = new CatalogService({
    fetcher: h.fetcher,
    apiKey: testKey,
    now: () => now,
    sourceRequestsPerMinute: 2,
  })
  await service.list({ query: 'first' })
  await service.list({ query: 'first' })
  await service.list({ query: 'second' })
  expect(h.calls).toHaveLength(2)
  await expect(service.list({ query: 'third' })).rejects.toMatchObject({
    status: 429,
    code: 'CATALOG_RATE_LIMIT',
  })
  now = 60001
  await service.list({ query: 'third' })
  expect(h.calls).toHaveLength(3)
})

it('preserves an explicit daily budget after the minute window resets', async () => {
  let now = 0
  const h = fixture()
  const service = new CatalogService({
    fetcher: h.fetcher,
    apiKey: testKey,
    now: () => now,
    sourceRequestsPerMinute: 120,
    sourceRequestsPerDay: 2,
  })
  await service.list({ query: 'first' })
  await service.list({ query: 'second' })
  now = 60001
  await expect(service.list({ query: 'third' })).rejects.toMatchObject({
    status: 429,
    code: 'CATALOG_RATE_LIMIT',
  })
  expect(h.calls).toHaveLength(2)
})

it('default routes apply explicit server quota settings without weakening public controls', async () => {
  vi.stubEnv('EIGHT004SCAN_API_KEY', testKey)
  vi.stubEnv('CATALOG_SOURCE_REQUESTS_PER_MINUTE', '1')
  vi.stubEnv('CATALOG_SOURCE_REQUESTS_PER_DAY', '20000')
  const h = fixture()
  vi.mocked(publicFetch).mockImplementation(h.fetcher)
  const app = Fastify()
  registerCatalogRoutes(app)
  try {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/catalog/agents?query=first' })).statusCode,
    ).toBe(200)
    const blocked = await app.inject({ method: 'GET', url: '/v1/catalog/agents?query=second' })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().error.code).toBe('CATALOG_RATE_LIMIT')
    expect(h.calls).toHaveLength(1)
  } finally {
    await app.close()
  }
})
