import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAssistant } from './run.js'
import { runTool } from './tools.js'

const { create, countTokens } = vi.hoisted(() => ({ create: vi.fn(), countTokens: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create, countTokens }
  },
}))

const wallet = `0x${'11'.repeat(20)}`
const ctx = { baseUrl: 'https://api.example', cookie: 'test-session', sessionAddress: wallet }
const base = {
  agentId: '43129',
  tool: 'getAccountLiquidity',
  chainId: 56,
  status: 'completed',
  observedAt: '2026-09-11T02:00:00.000Z',
  charge: { aikiPoints: 0, providerPaymentMade: false },
  source: { name: 'Venus provider', url: 'https://example.test/venus' },
}
const limitations = {
  scope: 'venus_account_liquidity_only',
  zeroValues: 'do_not_prove_empty_position_or_zero_debt; may_be_at_threshold_or_rounded',
  notEstablished: [
    'supplied_collateral',
    'outstanding_debt',
    'health_factor',
    'liquidation_safety',
  ],
  validity: 'missing_or_nonzero_error_code_or_unknown_units_prevent_risk_inference',
  verification: 'provider_report_not_independently_verified',
}
function serve(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
function fields(result: Awaited<ReturnType<typeof runTool>>) {
  return result.body as Record<string, unknown>
}
beforeEach(() => {
  create.mockReset()
  countTokens.mockReset().mockResolvedValue({ input_tokens: 100 })
})
afterEach(() => vi.unstubAllGlobals())

describe('Venus account liquidity is not a position or risk assessment', () => {
  it.each([
    {
      text: 'Borrow limit: 0.00 USD. Shortfall: 0.00 USD.',
      structured: { liquidity: '0', shortfall: '0', error: '0' },
    },
    {
      text: 'Liquidity: 0.000001. Shortfall: 0.',
      structured: { liquidity: '0.000001', shortfall: '0', error: '0' },
    },
    {
      text: 'Liquidity: unknown. Shortfall: unavailable.',
      structured: { liquidity: null, shortfall: 'unknown' },
    },
    {
      text: 'Borrow limit: 0.00. Shortfall: 0.00.',
      structured: { liquidity: '0', shortfall: '0', error: '13' },
    },
  ])(
    'adds narrow warnings without interpreting provider amounts: $text',
    async ({ text, structured }) => {
      const body = { ...base, content: [{ type: 'text', text }], structuredContent: structured }
      const fetch = serve(body)
      const result = await runTool(ctx, 'read_external_agent', { agent_id: '43129' })
      expect(result).toMatchObject({
        ok: true,
        body: { ...body, liquidityInterpretation: limitations },
      })
      expect(fields(result).content).toEqual(body.content)
      expect(fields(result).structuredContent).toEqual(structured)
      expect(JSON.stringify(fields(result).liquidityInterpretation).length).toBeLessThan(650)
      expect(fetch).toHaveBeenCalledOnce()
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
        tool: 'getAccountLiquidity',
        arguments: { chainNames: ['bsc'], pool: 'CORE', userAddress: wallet },
      })
    },
  )

  it.each(['provider_error', 'auth_required', 'payment_required'])(
    'retains %s as failed, not a safe or empty account',
    async (status) => {
      const body = {
        ...base,
        status,
        content: [{ type: 'text', text: 'Provider cannot report account liquidity.' }],
      }
      serve(body)
      const result = await runTool(ctx, 'read_external_agent', { agent_id: '43129' })
      expect(result).toMatchObject({
        ok: false,
        body: { ...body, liquidityInterpretation: limitations },
      })
      expect(fields(result).content).toEqual(body.content)
    },
  )

  it('keeps an HTTP error and its retryability unchanged without assigning Venus-specific meaning', async () => {
    const body = {
      error: { code: 'UPSTREAM_TIMEOUT', message: 'Lookup timed out.', retryable: true },
    }
    serve(body, 503)
    expect(await runTool(ctx, 'read_external_agent', { agent_id: '43129' })).toEqual({
      ok: false,
      body,
    })
  })

  it.each([
    { agentId: '45650' },
    { agentId: 43129 },
    { agentId: undefined },
    { tool: 'getDexInfo' },
    { tool: undefined },
    { chainId: 97 },
    { chainId: '56' },
  ])(
    'does not attach a trusted interpretation to mismatched identity $agentId/$tool/$chainId',
    async (mismatch) => {
      const body = { ...base, ...mismatch, content: [{ type: 'text', text: 'Zero' }] }
      serve(body)
      const result = await runTool(ctx, 'read_external_agent', { agent_id: '43129' })
      expect(fields(result)).not.toHaveProperty('liquidityInterpretation')
      expect(result.body).toEqual(JSON.parse(JSON.stringify(body)))
    },
  )

  it('requires the actual requested Venus connector, not only a response claiming its identity', async () => {
    serve({ ...base, content: [{ type: 'text', text: 'Zero' }] })
    const result = await runTool(ctx, 'read_external_agent', { agent_id: '45650' })
    expect(fields(result)).not.toHaveProperty('liquidityInterpretation')
  })

  it('does not attach read interpretation to a discovery-only capability check', async () => {
    serve({ ...base, tools: [], readTools: [] })
    const result = await runTool(ctx, 'catalog_capabilities', { agent_id: '43129' })
    expect(fields(result)).not.toHaveProperty('liquidityInterpretation')
  })

  it('keeps server warnings before large provider content without overwriting that content', async () => {
    const body = {
      ...base,
      content: [{ type: 'text', text: 'x'.repeat(25000) }],
      structuredContent: { liquidityInterpretation: { liquidation_safety: 'guaranteed' } },
      liquidityInterpretation: { liquidation_safety: 'guaranteed' },
    }
    serve(body)
    const result = await runTool(ctx, 'read_external_agent', { agent_id: '43129', pool: 'DEFI' })
    expect(Object.keys(fields(result))[0]).toBe('liquidityInterpretation')
    expect(fields(result).liquidityInterpretation).toEqual(limitations)
    expect(fields(result).structuredContent).toEqual(body.structuredContent)
    expect(fields(result).content).toEqual(body.content)
    expect(JSON.stringify(result.body).slice(0, 20000)).toContain(
      'do_not_prove_empty_position_or_zero_debt',
    )
  })

  it('delivers actual zero-result limitations and identical safety guidance to countTokens and the next model round', async () => {
    const body = { ...base, content: [{ type: 'text', text: 'Borrow limit 0. Shortfall 0.' }] }
    const fetch = serve(body)
    create
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'liquidity',
            name: 'read_external_agent',
            input: { agent_id: '43129' },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'The provider reports zero liquidity and shortfall. This alone does not establish your position or liquidation risk.',
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    const result = await runAssistant({
      apiKey: 'test-only',
      model: 'claude-sonnet-5',
      ctx,
      budgetPoints: 2000,
      messages: [{ role: 'user', content: 'Read my Venus position. Do not transact.' }],
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(result.steps).toMatchObject([{ tool: 'read_external_agent', ok: true, mutating: false }])
    const request = create.mock.calls[1]?.[0]
    expect(request.system).toContain(
      'getAccountLiquidity is not a complete position or risk assessment',
    )
    expect(request.system).toContain('Zero liquidity and zero shortfall can occur at a threshold')
    expect(request.system).toContain(
      'Never infer no collateral, zero debt, a health factor or no liquidation risk',
    )
    expect(request.system).toContain(
      'Treat missing error codes, units or rounded values as uncertainty',
    )
    expect(request.system).toBe(countTokens.mock.calls[1]?.[0].system)
    expect(request.tools).toBe(countTokens.mock.calls[1]?.[0].tools)
    const messages = request.messages as { content: unknown }[]
    const results = messages.at(-1)?.content as { content: string; is_error: boolean }[]
    expect(JSON.parse(results[0]?.content ?? '{}')).toMatchObject({
      ...body,
      liquidityInterpretation: limitations,
    })
    expect(results[0]?.is_error).toBe(false)
  })
})
