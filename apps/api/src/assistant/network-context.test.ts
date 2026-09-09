import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InMemoryCreditStore } from '../credits/store.js'
import { registerAssistantRoutes } from './routes.js'

const create = vi.fn()
const countTokens = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create, countTokens }
  },
}))
vi.mock('./tools.js', () => ({ TOOLS: [], MUTATING: new Set(), runTool: vi.fn() }))
const { assistantSystem, runAssistant, SYSTEM } = await import('./run.js')
const apps: ReturnType<typeof Fastify>[] = []
beforeEach(() => {
  create.mockReset().mockResolvedValue({
    content: [{ type: 'text', text: 'Open your points page.' }],
    usage: { input_tokens: 100, output_tokens: 20 },
  })
  countTokens.mockReset().mockResolvedValue({ input_tokens: 1000 })
})
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

it('keeps network guidance neutral until trusted deployment context is supplied', () => {
  expect(SYSTEM).not.toContain('mandate contracts and USDT deposit rail use BNB testnet')
  expect(SYSTEM).toContain('/credits')
  expect(SYSTEM).toContain('configured separately')
  expect(assistantSystem()).toBe(SYSTEM)
})

it('distinguishes configured execution and payment networks from verified availability', () => {
  const system = assistantSystem({ executionChainId: 56, depositChainId: 97 })
  expect(system).toContain('Execution is configured for BNB mainnet (56)')
  expect(system).toContain('USDT deposits are configured for BNB testnet (97)')
  expect(system).toContain('Configuration does not establish current payment availability')
  expect(system).toContain('/credits')
  expect(system).not.toMatch(/0x[a-fA-F0-9]{40}/)
  expect(assistantSystem({ executionChainId: 97, depositChainId: 56 })).toContain(
    'USDT deposits are configured for BNB mainnet (56)',
  )
  expect(assistantSystem({})).toContain('No USDT deposit rail is configured')
})

it('counts and sends the identical network-aware system prompt', async () => {
  const networkContext = { executionChainId: 56, depositChainId: 56 } as const
  await runAssistant({
    apiKey: 'test-only',
    model: 'claude-sonnet-5',
    ctx: { baseUrl: 'http://127.0.0.1:1', cookie: 'local-test' },
    messages: [{ role: 'user', content: 'Where do I buy points?' }],
    budgetPoints: 2000,
    networkContext,
  })
  expect(countTokens).toHaveBeenCalledOnce()
  expect(create).toHaveBeenCalledOnce()
  const system = assistantSystem(networkContext)
  expect(countTokens.mock.calls[0]?.[0].system).toBe(system)
  expect(create.mock.calls[0]?.[0].system).toBe(system)
})

it('passes only configured chain metadata from the HTTP route to the model', async () => {
  const app = Fastify()
  apps.push(app)
  app.addHook('onRequest', async (request) => {
    request.session = { address: `0x${'12'.repeat(20)}`, chainId: 97, exp: 9999999999 }
  })
  const treasury = `0x${'ab'.repeat(20)}` as const
  registerAssistantRoutes(app, {
    credits: new InMemoryCreditStore(),
    selfUrl: 'http://127.0.0.1:1',
    apiKey: 'test-only',
    executionChainId: 56,
    deposits: {
      chainId: 56,
      decimals: 18,
      treasury,
      token: '0x55d398326f99059ff775485246999027b3197955',
      rpcUrl: 'http://127.0.0.1:1',
    },
  })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { cookie: 'local-test-only' },
    payload: { messages: [{ role: 'user', content: 'Where do I buy points?' }] },
  })
  expect(response.statusCode).toBe(200)
  const system = create.mock.calls[0]?.[0].system
  expect(system).toContain('Execution is configured for BNB mainnet (56)')
  expect(system).toContain('USDT deposits are configured for BNB mainnet (56)')
  expect(system).not.toContain(treasury)
  expect(system).toBe(countTokens.mock.calls[0]?.[0].system)
})
