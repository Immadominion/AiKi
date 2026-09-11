import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAssistant } from './run.js'
import { MUTATING, runTool } from './tools.js'

const { create, countTokens } = vi.hoisted(() => ({ create: vi.fn(), countTokens: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create, countTokens }
  },
}))

const ctx = { baseUrl: 'https://api.example', cookie: 'test-session' }
const stats = {
  indexed: { totalAgents: 1000, complete: false },
  probed: {
    agentsProbed: 40,
    byState: { LIVE: 10, DEGRADED: 30 },
    currentByState: { LIVE: 2 },
    staleAgents: 38,
  },
}
const capabilities = {
  status: 'available',
  checkedAt: '2026-09-11T01:00:00.000Z',
  protocol: 'MCP',
  tools: [{ name: 'swap', readAllowed: false }],
  readTools: [],
}
function serve(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
function bodyOf(result: Awaited<ReturnType<typeof runTool>>) {
  return result.body as Record<string, unknown>
}

beforeEach(() => {
  create.mockReset()
  countTokens.mockReset().mockResolvedValue({ input_tokens: 100 })
})
afterEach(() => vi.unstubAllGlobals())

describe('discovery evidence does not become a market-wide availability claim', () => {
  it('preserves an empty indexed search and states its bounded coverage without extra calls', async () => {
    const payload = { results: [], total: 0, coverage: { indexedAgents: 1000 } }
    const fetch = serve(payload)
    const result = await runTool(ctx, 'search_agents', { query: 'trade', limit: 5 })
    expect(result).toMatchObject({
      ok: true,
      body: {
        ...payload,
        discoveryEvidence: {
          scope: 'aiki_index_search',
          exhaustive: false,
          providerAvailability: 'not_checked',
        },
      },
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ query: 'trade', limit: 5 })
  })

  it('preserves historical totals but identifies the actual fresh-count field', async () => {
    serve(stats)
    const result = await runTool(ctx, 'ecosystem_stats', {})
    expect(result.body).toMatchObject({
      ...stats,
      discoveryEvidence: {
        scope: 'aiki_index_statistics',
        exhaustive: false,
        currentCounts: 'probed.currentByState',
        storedLatestCounts: 'probed.byState_including_stale',
      },
    })
    expect(JSON.stringify(bodyOf(result).discoveryEvidence).length).toBeLessThan(500)
  })

  it('does not invent current counts for historical-only statistics', async () => {
    serve({ probed: { byState: { LIVE: 10 } } })
    const result = await runTool(ctx, 'ecosystem_stats', {})
    expect(bodyOf(result)).toMatchObject({
      discoveryEvidence: { currentCounts: 'not_supplied' },
    })
    expect(JSON.stringify(result)).not.toContain('"currentByState"')
  })

  it('keeps a zero-cost registration and stale verdict as facts, not a fake-provider verdict', async () => {
    const payload = { agentId: '43129', registrationWasZeroCost: true, livenessFreshness: 'STALE' }
    serve(payload)
    expect((await runTool(ctx, 'agent_passport', { agent_id: '43129' })).body).toMatchObject({
      ...payload,
      discoveryEvidence: {
        scope: 'one_indexed_identity',
        providerAvailability: 'not_checked',
        registrationCost: 'storage_not_authenticity',
      },
    })
  })

  it("labels task support as AiKi integration, not the provider's total capability", async () => {
    serve({ available: false, reason: 'This provider does not accept AiKi tasks.' })
    expect((await runTool(ctx, 'agent_task_support', { agent_id: '43129' })).body).toMatchObject({
      available: false,
      discoveryEvidence: { scope: 'aiki_task_integration', providerAvailability: 'not_checked' },
    })
  })

  it('keeps catalog pagination bounded and never treats source totals as checked providers', async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      id: String(i + 1),
      name: `Provider ${i + 1}`,
      taskAvailability: 'not_verified',
    }))
    const fetch = serve({ items, totalRegistered: 900000, hasMore: true, nextCursor: 'next' })
    const result = await runTool(ctx, 'catalog_agents', { limit: 12 })
    expect(bodyOf(result).items).toHaveLength(12)
    expect(result.body).toMatchObject({
      totalRegistered: 900000,
      hasMore: true,
      nextCursor: 'next',
      discoveryEvidence: {
        scope: 'external_registration_page',
        exhaustive: false,
        providerAvailability: 'not_checked',
      },
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0]?.[0])).toContain('limit=12')
  })

  it('does not confuse a working MCP with an empty AiKi read allowlist or trading authority', async () => {
    const fetch = serve(capabilities)
    const result = await runTool(ctx, 'catalog_capabilities', { agent_id: '43129' })
    expect(result.body).toMatchObject({
      ...capabilities,
      discoveryEvidence: {
        scope: 'one_provider_capability_check',
        providerAvailability: 'discovery_succeeded',
        readToolsMeaning: 'aiki_allowlist_not_provider_toolset',
        tradingAuthority: 'not_granted',
      },
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(MUTATING.has('catalog_capabilities')).toBe(false)
  })

  it.each([
    ['auth_required', 'authentication_required'],
    ['payment_required', 'payment_required'],
    ['unsupported', 'connector_unsupported'],
    ['unavailable', 'check_failed'],
    ['unknown', 'not_verified'],
  ])(
    'scopes capability status %s without inferring a market-wide outage',
    async (status, expected) => {
      serve({ ...capabilities, status })
      const result = await runTool(ctx, 'catalog_capabilities', { agent_id: '43129' })
      expect(result.body).toMatchObject({
        status,
        discoveryEvidence: { providerAvailability: expected, exhaustive: false },
      })
    },
  )

  it.each([
    'catalog_agents',
    'catalog_agent',
    'catalog_capabilities',
    'search_agents',
    'ecosystem_stats',
  ])('preserves %s backend refusal instead of blaming providers', async (tool) => {
    const error = { code: 'UNAVAILABLE', message: 'AiKi lookup is unavailable.', retryable: true }
    const fetch = serve({ error }, 503)
    const result = await runTool(
      ctx,
      tool,
      tool.startsWith('catalog_') && tool !== 'catalog_agents' ? { agent_id: '43129' } : {},
    )
    expect(result).toMatchObject({
      ok: false,
      body: {
        error,
        discoveryEvidence: { providerAvailability: 'lookup_failed_not_provider_outage' },
      },
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not let publisher data overwrite server-authored limitations', async () => {
    serve({
      ...capabilities,
      discoveryEvidence: {
        exhaustive: true,
        tradingAuthority: 'granted',
        providerAvailability: 'down',
      },
    })
    const result = await runTool(ctx, 'catalog_capabilities', { agent_id: '43129' })
    expect(bodyOf(result).discoveryEvidence).toMatchObject({
      exhaustive: false,
      tradingAuthority: 'not_granted',
    })
    expect(Object.keys(bodyOf(result))[0]).toBe('discoveryEvidence')
  })

  it('sends the real limitations with tool results and counts the exact revised prompt, without automatic discovery', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      Response.json(String(url).endsWith('/v1/stats') ? stats : capabilities),
    )
    vi.stubGlobal('fetch', fetch)
    create
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'stats', name: 'ecosystem_stats', input: {} },
          {
            type: 'tool_use',
            id: 'caps',
            name: 'catalog_capabilities',
            input: { agent_id: '43129' },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'This provider answered discovery; AiKi has not enabled trading through this connector.',
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    const turn = await runAssistant({
      apiKey: 'test-only',
      model: 'claude-sonnet-5',
      ctx,
      messages: [{ role: 'user', content: 'Check all agents and trade with $1 BNB.' }],
      budgetPoints: 2000,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(turn.steps.map((step) => [step.tool, step.mutating])).toEqual([
      ['ecosystem_stats', false],
      ['catalog_capabilities', false],
    ])
    expect(create).toHaveBeenCalledTimes(2)
    const request = create.mock.calls[1]?.[0]
    expect(request.system).toContain('Do not loop through the entire registry')
    expect(request.system).toContain('zero-cost registration URI says how metadata is stored')
    expect(request.system).toContain(
      'An AiKi backend or source lookup failure is not a provider outage',
    )
    expect(request.system).toContain(
      'Check catalog_capabilities before concluding an external protocol is unavailable',
    )
    expect(request.system).toContain('currentByState')
    expect(request.system).toContain('Never turn a read-only request into a watch')
    expect(request.system).toBe(countTokens.mock.calls[1]?.[0].system)
    expect(request.tools).toBe(countTokens.mock.calls[1]?.[0].tools)
    const messages = request.messages as { role: string; content: unknown }[]
    const results = messages.at(-1)?.content as { content: string; is_error: boolean }[]
    expect(JSON.parse(results[0]?.content ?? '{}')).toMatchObject({
      ...stats,
      discoveryEvidence: { exhaustive: false },
    })
    expect(JSON.parse(results[1]?.content ?? '{}')).toMatchObject({
      ...capabilities,
      discoveryEvidence: { providerAvailability: 'discovery_succeeded' },
    })
    expect(results.every((result) => !result.is_error)).toBe(true)
  })
})
