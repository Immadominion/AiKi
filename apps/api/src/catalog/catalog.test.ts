import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { BoundedCache, WindowBudget } from './bounds.js'
import { connectMcp, rpcResult } from './mcp.js'
import { allowedReadTools, matchesSchema, validateRead } from './read-policy.js'
import { registerCatalogRoutes } from './routes.js'
import { CatalogService, normalizeAgent, validateId, validateQuery } from './service.js'
import { boundedText, type CatalogFetch, publicFetch, safeEndpoint } from './transport.js'
import { CatalogError, type CatalogTool, type JsonObject } from './types.js'

const wallet = '0x1111111111111111111111111111111111111111'
const rawAgent = (id = '45650') => ({
  token_id: id,
  chain_id: 56,
  contract_address: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  owner_address: '0xda977767452c5dd021624511f14df67b6c9c2c1b',
  name: 'V3 Pools powered by HeyAnon',
  description: 'Provider description, not AiKi verification.',
  image_url: 'https://untrusted.example/image.png',
  categories: ['Provider-declared'],
  supported_protocols: ['MCP'],
  x402_supported: true,
  services: {
    mcp: { endpoint: `https://erc8004.heyanon.ai/mcp/${id === '43129' ? 'venus' : 'v3pools'}` },
  },
})
const tool: CatalogTool = {
  name: 'getDexInfo',
  description: 'Returns chain information',
  readAllowed: false,
  inputSchema: {
    type: 'object',
    properties: {
      chainName: { anyOf: [{ type: 'string', enum: ['bsc', 'ethereum'] }, { type: 'null' }] },
    },
    required: ['chainName'],
    additionalProperties: false,
  },
}
function rpc(id: number, result: unknown, status = 201, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
function fixtureFetch(
  onCall?: (method: string, body: JsonObject, init: RequestInit) => void,
): CatalogFetch {
  return vi.fn(async (url, init) => {
    if (url.hostname === 'api.8004scan.io') {
      if (/\/agents\/56\/\d+$/.test(url.pathname))
        return new Response(JSON.stringify(rawAgent(url.pathname.split('/').at(-1))), {
          headers: { 'content-type': 'application/json' },
        })
      return new Response(
        JSON.stringify({ items: [rawAgent()], total: 1, has_more: false, next_cursor: null }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    const body = JSON.parse(String(init.body)) as JsonObject
    const method = String(body.method)
    onCall?.(method, body, init)
    if (method === 'initialize')
      return rpc(1, { protocolVersion: '2025-06-18', capabilities: { tools: {} } }, 201, {
        'mcp-session-id': 'private-test-session',
      })
    if (method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (method === 'tools/list')
      return rpc(2, { tools: [tool, { name: 'createPosition', inputSchema: { type: 'object' } }] })
    return rpc(3, { content: [{ type: 'text', text: 'Real provider fixture result' }] })
  })
}

describe('catalog inputs and source identity', () => {
  it('validates IDs without precision loss or accepting URL injection', () => {
    expect(validateId('12345678901234567890')).toBe('12345678901234567890')
    for (const id of [
      '../43129',
      '01',
      '-1',
      '1.5',
      '1?url=http://localhost',
      (2n ** 256n).toString(),
    ])
      expect(() => validateId(id)).toThrow()
  })
  it('validates query, protocol, category, size and opaque cursor', () => {
    expect(
      validateQuery({
        query: ' Venus ',
        protocol: 'MCP',
        category: 'health_factor',
        limit: '20',
        cursor: 'eyJzdWI_abc-123=',
      }),
    ).toEqual({
      query: 'Venus',
      protocol: 'MCP',
      category: 'health_factor',
      limit: 20,
      cursor: 'eyJzdWI_abc-123=',
    })
    for (const input of [
      { limit: 500 },
      { limit: '2e1' },
      { query: ['one', 'two'] },
      { query: 'x'.repeat(161) },
      { protocol: 'http' },
      { category: 'fake' },
      { cursor: 'x&chain_id=1' },
      { url: 'http://localhost' },
    ])
      expect(() => validateQuery(input)).toThrow()
  })
  it('preserves real identity and category declarations, never source ratings', () => {
    const agent = normalizeAgent({ ...rawAgent(), total_score: 100, health_score: 100 })
    expect(agent.sourceId).toBe('56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:45650')
    expect(agent.imageUrl).toBe('https://api.8004scan.io/api/v1/media/agents/56/45650/image')
    expect(agent.declaredCategories).toEqual(['Provider-declared'])
    expect(agent.taskAvailability).toBe('not_verified')
    expect(agent.connector).toBe('read_only_candidate')
    expect(agent).not.toHaveProperty('rating')
    expect(agent).not.toHaveProperty('total_score')
    expect(() => normalizeAgent({ ...rawAgent(), chain_id: 1 })).toThrow()
    expect(() => normalizeAgent({ ...rawAgent(), agent_id: '56:wrong:45650' })).toThrow()
  })
  it('does not normalize unsafe endpoint registrations into executable connectors', () => {
    const agent = normalizeAgent({
      ...rawAgent(),
      services: { mcp: { endpoint: 'file:///etc/passwd' } },
    })
    expect(agent.services).toEqual([])
    expect(agent.connector).toBe('discovery_only')
  })
  it('uses only bounded BSC source queries and caches/coalesces identical requests', async () => {
    const fetcher = fixtureFetch()
    const service = new CatalogService({ fetcher })
    const pages = await Promise.all([
      service.list({ protocol: 'MCP', category: 'health_factor' }),
      service.list({ protocol: 'MCP', category: 'health_factor' }),
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    const url = vi.mocked(fetcher).mock.calls[0]?.[0]
    expect(url?.searchParams.get('chain_id')).toBe('56')
    expect(url?.searchParams.get('search')).toBe('lending')
    expect(url?.searchParams.get('supported_protocol')).toBe('MCP')
    expect(pages[0]?.countMeaning).toBe('registered_agents_not_verified_working')
    expect(pages[0]?.categoryMatch).toBe('source_text')
  })
  it('respects upstream Retry-After across different cache keys', async () => {
    const fetcher = vi
      .fn<CatalogFetch>()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '120' } }))
    const service = new CatalogService({ fetcher })
    await expect(service.list({})).rejects.toMatchObject({ status: 429, retryAfter: 120 })
    await expect(service.detail('43129')).rejects.toMatchObject({ status: 429 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('bounded safe transport', () => {
  it.each([
    'http://example.com/mcp',
    'https://user:pass@example.com/mcp',
    'https://example.com:8443/mcp',
    'file:///etc/passwd',
    'https://example.com/#secret',
  ])('rejects unsafe endpoint %s', (url) => {
    expect(() => safeEndpoint(url)).toThrow()
  })
  it.each([
    'https://127.0.0.1/mcp',
    'https://169.254.169.254/mcp',
    'https://[::1]/mcp',
    'https://localhost/mcp',
  ])('rejects non-public destination without an HTTP request: %s', async (url) => {
    await expect(
      publicFetch(new URL(url), { signal: AbortSignal.timeout(1000) }),
    ).rejects.toMatchObject({ code: 'UNSAFE_ENDPOINT' })
  })
  it('caps content length and streamed bytes', async () => {
    await expect(boundedText(new Response('abcdef'), 3)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    })
    await expect(
      boundedText(new Response('x', { headers: { 'content-length': '1000' } }), 10),
    ).rejects.toThrow()
  })
})

describe('MCP standard discovery', () => {
  it('accepts201 and forwards only private session/protocol headers, never ambient credentials', async () => {
    const calls: string[] = []
    const session = await connectMcp(
      'https://erc8004.heyanon.ai/mcp/v3pools',
      fixtureFetch((method, _body, init) => {
        calls.push(method)
        const headers = new Headers(init.headers)
        expect(headers.get('accept')).toBe('application/json, text/event-stream')
        expect(headers.has('authorization')).toBe(false)
        expect(headers.has('cookie')).toBe(false)
        if (method !== 'initialize') {
          expect(headers.get('mcp-session-id')).toBe('private-test-session')
          expect(headers.get('mcp-protocol-version')).toBe('2025-06-18')
        }
      }),
    )
    expect(calls).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(session.tools).toHaveLength(2)
    session.close()
  })
  it('parses SSE with notifications and unrelated IDs, closing an open stream on matching result', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"jsonrpc":"2.0","method":"sampling/createMessage","id":9}\r\n\r\ndata: {"jsonrpc":"2.0","id":99,"result":{}}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n',
          ),
        )
      },
      cancel,
    })
    expect(
      await rpcResult(
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
        2,
      ),
    ).toEqual({ tools: [] })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it.each([
    [401, 'PROVIDER_AUTH_REQUIRED'],
    [403, 'PROVIDER_AUTH_REQUIRED'],
    [402, 'PROVIDER_PAYMENT_REQUIRED'],
    [429, 'PROVIDER_RATE_LIMIT'],
  ])(
    'reports HTTP%s without following authentication/payment instructions',
    async (status, code) => {
      await expect(
        rpcResult(new Response('untrusted payment instructions', { status: Number(status) }), 1),
      ).rejects.toMatchObject({ code })
    },
  )
  it('does not interpret unrelated JSON RPC IDs as successful discovery', async () => {
    await expect(rpcResult(rpc(99, { tools: [] }), 2)).rejects.toMatchObject({
      code: 'INVALID_PROTOCOL',
    })
  })
  it('does not claim all tools when provider list is paginated', async () => {
    const fetcher = fixtureFetch()
    const wrapped: CatalogFetch = async (url, init) =>
      JSON.parse(String(init.body)).method === 'tools/list'
        ? rpc(2, { tools: [tool], nextCursor: 'more' })
        : fetcher(url, init)
    const session = await connectMcp('https://example.com/mcp', wrapped)
    expect(session.truncated).toBe(true)
    session.close()
  })
})

describe('explicit read policy', () => {
  it('allows only the known identity, exact endpoint and reviewed tool', () => {
    const agent = normalizeAgent(rawAgent())
    expect(allowedReadTools(agent, [tool]).map((entry) => entry.name)).toEqual(['getDexInfo'])
    expect(allowedReadTools({ ...agent, ownerAddress: wallet }, [tool])).toEqual([])
    expect(allowedReadTools({ ...agent, id: '999' }, [tool])).toEqual([])
    expect(
      allowedReadTools(
        { ...agent, services: [{ protocol: 'MCP', endpoint: 'https://evil.example/mcp' }] },
        [tool],
      ),
    ).toEqual([])
    expect(() => validateRead(agent, [tool], 'createPosition', {}, wallet)).toThrow()
    expect(() =>
      validateRead(agent, [tool], 'getDexInfo', { chainName: 'ethereum' }, wallet),
    ).toThrow()
    expect(() =>
      validateRead(agent, [tool], 'getDexInfo', { chainName: 'bsc', transfer: true }, wallet),
    ).toThrow()
    expect(validateRead(agent, [tool], 'getDexInfo', { chainName: 'bsc' }, wallet)).toEqual({
      chainName: 'bsc',
    })
  })
  it('fails closed on schema changes and unknown validators', () => {
    expect(
      matchesSchema({ chainName: 'bsc' }, { ...tool.inputSchema, $ref: 'http://localhost/schema' }),
    ).toBe(false)
    expect(
      allowedReadTools(normalizeAgent(rawAgent()), [
        { ...tool, inputSchema: { type: 'object', required: ['privateKey'] } },
      ]),
    ).toEqual([])
  })
  it('binds Venus reads to the authenticated wallet', () => {
    const agent = normalizeAgent(rawAgent('43129'))
    const liquidity: CatalogTool = {
      name: 'getAccountLiquidity',
      description: '',
      readAllowed: true,
      inputSchema: {
        type: 'object',
        properties: {
          chainNames: { type: 'array', items: { type: 'string', enum: ['bsc'] } },
          pool: { type: 'string', enum: ['CORE', 'DEFI'] },
          userAddress: { type: 'string' },
        },
        required: ['chainNames', 'pool', 'userAddress'],
        additionalProperties: false,
      },
    }
    expect(() =>
      validateRead(
        agent,
        [liquidity],
        'getAccountLiquidity',
        {
          chainNames: ['bsc'],
          pool: 'CORE',
          userAddress: '0x2222222222222222222222222222222222222222',
        },
        wallet,
      ),
    ).toThrow()
    expect(
      validateRead(
        agent,
        [liquidity],
        'getAccountLiquidity',
        { chainNames: ['bsc'], pool: 'CORE', userAddress: wallet },
        wallet,
      ),
    ).toHaveProperty('userAddress', wallet)
  })
  it('runs a genuine protocol call without charging AiKi or manufacturing a job', async () => {
    const methods: string[] = []
    const service = new CatalogService({ fetcher: fixtureFetch((method) => methods.push(method)) })
    const result = await service.read('45650', 'getDexInfo', { chainName: 'bsc' }, wallet)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    expect(result.status).toBe('completed')
    expect(result.charge).toEqual({ aikiPoints: 0, providerPaymentMade: false })
    expect(result).not.toHaveProperty('jobId')
    expect(JSON.stringify(result)).not.toContain('private-test-session')
  })
  it('refuses unsafe calls before touching any MCP endpoint', async () => {
    const methods: string[] = []
    const service = new CatalogService({ fetcher: fixtureFetch((method) => methods.push(method)) })
    await expect(service.read('45650', 'createPosition', {}, wallet)).rejects.toMatchObject({
      code: 'TOOL_NOT_ALLOWED',
    })
    await expect(
      service.read('45650', 'getDexInfo', { chainName: 'bsc', secret: 'no' }, wallet),
    ).rejects.toThrow()
    expect(methods).toEqual([])
  })
  it('stops on402 instead of inventing payment or a delivered task', async () => {
    const original = fixtureFetch()
    const fetcher: CatalogFetch = async (url, init) =>
      init.body && JSON.parse(String(init.body)).method === 'tools/call'
        ? new Response(null, { status: 402 })
        : original(url, init)
    const result = await new CatalogService({ fetcher }).read(
      '45650',
      'getDexInfo',
      { chainName: 'bsc' },
      wallet,
    )
    expect(result.status).toBe('payment_required')
    expect(result.charge.providerPaymentMade).toBe(false)
  })
})

describe('HTTP authentication and abuse bounds', () => {
  async function appWithSession(address?: string) {
    const app = Fastify()
    app.addHook('onRequest', async (request) => {
      if (address) request.session = { address, chainId: 56, exp: Date.now() / 1000 + 600 }
    })
    const service = new CatalogService({ fetcher: fixtureFetch() })
    const read = vi.spyOn(service, 'read')
    registerCatalogRoutes(app, service)
    return { app, read }
  }
  it('requires a real session and matching selected-wallet header', async () => {
    const unsigned = await appWithSession()
    const signed = await appWithSession(wallet)
    const payload = { tool: 'getDexInfo', arguments: { chainName: 'bsc' } }
    expect(
      (
        await unsigned.app.inject({
          method: 'POST',
          url: '/v1/catalog/agents/45650/read',
          headers: { 'x-aiki-wallet-address': wallet },
          payload,
        })
      ).statusCode,
    ).toBe(401)
    expect(unsigned.read).not.toHaveBeenCalled()
    expect(
      (await signed.app.inject({ method: 'POST', url: '/v1/catalog/agents/45650/read', payload }))
        .statusCode,
    ).toBe(401)
    expect(
      (
        await signed.app.inject({
          method: 'POST',
          url: '/v1/catalog/agents/45650/read',
          headers: { 'x-aiki-wallet-address': '0x2222222222222222222222222222222222222222' },
          payload,
        })
      ).statusCode,
    ).toBe(401)
    expect(signed.read).not.toHaveBeenCalled()
    const valid = await signed.app.inject({
      method: 'POST',
      url: '/v1/catalog/agents/45650/read',
      headers: { 'x-aiki-wallet-address': wallet },
      payload,
    })
    expect(valid.statusCode).toBe(200)
    expect(valid.json().status).toBe('completed')
    expect(valid.headers['cache-control']).toBe('no-store')
    await unsigned.app.close()
    await signed.app.close()
  })
  it('caps request body and public discovery frequency', async () => {
    const { app } = await appWithSession(wallet)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/catalog/agents/45650/read',
          payload: { tool: 'x', arguments: { x: 'x'.repeat(5000) } },
        })
      ).statusCode,
    ).toBe(413)
    for (let i = 0; i < 6; i++)
      expect((await app.inject('/v1/catalog/agents/45650/capabilities')).statusCode).toBe(200)
    expect((await app.inject('/v1/catalog/agents/45650/capabilities')).statusCode).toBe(429)
    await app.close()
  })
  it('caps window keys without evicting active identities to reset their rate limits', () => {
    let now = 0
    const budget = new WindowBudget(1, 1000, 2, () => now)
    budget.take('a')
    budget.take('b')
    expect(() => budget.take('a')).toThrow(CatalogError)
    expect(() => budget.take('c')).toThrow(CatalogError)
    now = 1001
    expect(() => budget.take('c')).not.toThrow()
  })
  it('bounds and expires cache entries while deduplicating in-flight loads', async () => {
    let now = 0
    const cache = new BoundedCache<number>(1, 10, () => now)
    const loader = vi.fn(async () => 42)
    await Promise.all([cache.get('a', loader), cache.get('a', loader)])
    expect(loader).toHaveBeenCalledTimes(1)
    await cache.get('b', loader)
    await cache.get('a', loader)
    expect(loader).toHaveBeenCalledTimes(3)
    now = 11
    await cache.get('a', loader)
    expect(loader).toHaveBeenCalledTimes(4)
  })
})
