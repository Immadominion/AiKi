import { afterEach, describe, expect, it, vi } from 'vitest'
import { SYSTEM } from '../assistant/run.js'
import { MUTATING, runTool, TOOLS } from '../assistant/tools.js'

const address = '0x1111111111111111111111111111111111111111'
const ctx = {
  baseUrl: 'https://api.example',
  cookie: 'signed-test-session',
  sessionAddress: address,
}
afterEach(() => vi.unstubAllGlobals())

describe('Fast external catalog tools use the same guarded HTTP routes', () => {
  it('registers only readonly catalog tools and explains real routes and separate chat cost', () => {
    for (const name of [
      'catalog_agents',
      'catalog_agent',
      'catalog_capabilities',
      'read_external_agent',
    ]) {
      expect(TOOLS.some((tool) => tool.name === name)).toBe(true)
      expect(MUTATING.has(name)).toBe(false)
    }
    expect(SYSTEM).toContain('/catalog/ID')
    expect(SYSTEM).toContain('model usage still costs points')
    expect(SYSTEM).toContain('not working agents')
  })
  it('forwards bounded source filters and preserves registration attribution', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        totalRegistered: 900,
        items: [
          {
            id: '45650',
            name: 'V3 Pools',
            description: 'Provider data',
            declaredProtocols: ['MCP'],
            taskAvailability: 'not_verified',
          },
        ],
        nextCursor: 'next',
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await runTool(ctx, 'catalog_agents', {
      query: 'pools',
      protocol: 'MCP',
      category: 'yield_optimisation',
      limit: 4,
    })
    expect(result.ok).toBe(true)
    const url = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/v1/catalog/agents')
    expect(url.searchParams.get('query')).toBe('pools')
    expect(url.searchParams.get('protocol')).toBe('MCP')
    expect(url.searchParams.get('category')).toBe('yield_optimisation')
    expect(result.body).toMatchObject({
      totalRegistered: 900,
      items: [{ href: '/catalog/45650', taskAvailability: 'not_verified' }],
    })
  })
  it('only sends the reviewed public DEX read with trusted wallet/session binding', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ status: 'completed', charge: { aikiPoints: 0, providerPaymentMade: false } }),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await runTool(ctx, 'read_external_agent', { agent_id: '45650' })
    expect(result.ok).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example/v1/catalog/agents/45650/read',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'signed-test-session',
          'x-aiki-wallet-address': address,
        },
      }),
    )
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      tool: 'getDexInfo',
      arguments: { chainName: 'bsc' },
    })
  })
  it('injects the accepted wallet for Venus rather than accepting model-provided addresses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: 'completed' }))
    vi.stubGlobal('fetch', fetch)
    await runTool(ctx, 'read_external_agent', { agent_id: '43129', pool: 'DEFI' })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      tool: 'getAccountLiquidity',
      arguments: { chainNames: ['bsc'], pool: 'DEFI', userAddress: address },
    })
    const denied = await runTool(ctx, 'read_external_agent', {
      agent_id: '43129',
      userAddress: '0x2222222222222222222222222222222222222222',
    })
    expect(denied.ok).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['read_external_agent', { agent_id: '45650', tool: 'swap' }],
    ['read_external_agent', { agent_id: '45650', endpoint: 'https://evil.example' }],
    ['read_external_agent', { agent_id: '99999' }],
    ['read_external_agent', { agent_id: '43129', pool: ['CORE'] }],
    ['catalog_agents', { limit: 100 }],
    ['catalog_agents', { protocol: 'http' }],
    ['catalog_agent', { agent_id: '../account' }],
  ])('refuses invalid%s before any HTTP call', async (name, args) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await runTool(ctx, name, args)
    expect(result.ok).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('refuses a cookie-only read when the accepted wallet context is absent', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await runTool(
      { baseUrl: ctx.baseUrl, cookie: ctx.cookie },
      'read_external_agent',
      { agent_id: '45650' },
    )
    expect(result).toMatchObject({ ok: false, body: { error: { code: 'UNAUTHENTICATED' } } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('returns provider authentication/payment states as refusals, never successful paid work', async () => {
    for (const status of ['auth_required', 'payment_required', 'provider_error']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ status, charge: { aikiPoints: 0, providerPaymentMade: false } }),
        ),
      )
      const result = await runTool(ctx, 'read_external_agent', { agent_id: '45650' })
      expect(result).toMatchObject({
        ok: false,
        body: { status, charge: { providerPaymentMade: false } },
      })
    }
  })
  it('summarizes provider tools without leaking all schemas into model context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          status: 'available',
          tools: Array.from({ length: 30 }, (_, id) => ({
            name: `tool${id}`,
            description: 'A'.repeat(1000),
            inputSchema: { private: 'untrusted-schema' },
          })),
          readTools: [{ name: 'getDexInfo' }],
        }),
      ),
    )
    const result = await runTool(ctx, 'catalog_capabilities', { agent_id: '45650' })
    expect(result.body).toMatchObject({
      discoveredToolsOnPage: 30,
      toolSummaryTruncated: true,
      href: '/catalog/45650',
    })
    expect(JSON.stringify(result.body)).not.toContain('untrusted-schema')
  })
})
