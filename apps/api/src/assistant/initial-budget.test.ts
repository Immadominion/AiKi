import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pointsFor, WELCOME_GRANT_POINTS } from '../credits/pricing.js'
import { InMemoryCreditStore, RESERVE_ACCOUNT } from '../credits/store.js'
import { InMemoryConversationStore } from './conversations.js'
import { registerAssistantRoutes } from './routes.js'

const create = vi.fn()
const countTokens = vi.fn()
const tool = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create, countTokens }
  },
}))
vi.mock('./tools.js', () => ({
  TOOLS: [],
  MUTATING: new Set<string>(),
  runTool: (...args: unknown[]) => tool(...args),
}))

const owner = `0x${'12'.repeat(20)}`
const apps: ReturnType<typeof Fastify>[] = []
beforeEach(() => {
  create.mockReset()
  countTokens.mockReset()
  tool.mockReset()
})
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function harness(balance: number, content = 'Read my account.') {
  const app = Fastify()
  apps.push(app)
  const credits = new InMemoryCreditStore()
  await credits.grantWelcome({ owner, points: WELCOME_GRANT_POINTS, dailyLimit: 200 })
  if (balance < WELCOME_GRANT_POINTS)
    await credits.charge({
      owner,
      points: WELCOME_GRANT_POINTS - balance,
      reason: 'test:prior-usage',
    })
  const conversations = new InMemoryConversationStore()
  const conversationId = randomUUID()
  await conversations.create(owner, conversationId)
  app.addHook('onRequest', async (request) => {
    request.session = { address: owner, chainId: 97, exp: 9999999999 }
  })
  registerAssistantRoutes(app, {
    credits,
    conversations,
    apiKey: 'test-only',
    selfUrl: 'http://127.0.0.1:1',
  })
  const ask = () =>
    app.inject({
      method: 'POST',
      url: '/v1/assistant/messages',
      headers: { cookie: 'local-test-only', 'idempotency-key': 'initial-budget' },
      payload: { conversationId, messages: [{ role: 'user', content }] },
    })
  return { credits, conversations, conversationId, ask }
}

it.each([
  { balance: 200, inputTokens: 100, content: 'Hi.' },
  { balance: 250, inputTokens: 100, content: 'Hi.' },
  { balance: 292, inputTokens: 100, content: 'Hi.' },
  {
    balance: 525,
    inputTokens: 8330,
    content:
      'Is automated grid strategy setup available on BNB mainnet right now? Only check availability and show the setup page if it is available. Do not create an account, buy anything, fund, sign, or start a strategy.',
  },
  { balance: 500, inputTokens: 9_000, content: 'Explain these positions. '.repeat(200) },
  { balance: 5_000, inputTokens: 100_000, content: 'Review this larger context.' },
])(
  'refuses an unaffordable first round with $balance points and $inputTokens measured input tokens',
  async ({ balance, inputTokens, content }) => {
    countTokens.mockResolvedValue({ input_tokens: inputTokens })
    const h = await harness(balance, content)
    const requiredPoints = pointsFor('claude-sonnet-5', {
      inputTokens: Math.ceil(inputTokens * 1.05) + 256,
      outputTokens: 1500,
    })
    const first = await h.ask()
    expect(first.statusCode).toBe(402)
    expect(first.json()).toMatchObject({
      error: {
        code: 'ASSISTANT_BUDGET_TOO_SMALL',
        requiredPoints,
        availablePoints: Math.min(balance, 2000),
        retryable: false,
      },
      steps: [],
      cost: { points: 0, balance, held: Math.min(balance, 2000) },
    })
    expect(first.json().reply).toContain('No points were charged and no tools ran.')
    expect(first.json().reply).not.toMatch(/shorten|new conversation/i)
    if (requiredPoints > 2000) {
      expect(first.json().reply).toContain('exceeds the 2000 point limit')
      expect(first.json().reply).not.toContain('Add points')
      expect(first.json().reply).toContain('More points will not raise this limit.')
    } else {
      expect(first.json().reply).toBe(
        `This turn needs ${requiredPoints} points available; you have ${balance}. No points were charged and no tools ran. Add points to continue.`,
      )
    }
    expect(create).not.toHaveBeenCalled()
    expect(tool).not.toHaveBeenCalled()
    expect(await h.credits.balance(owner)).toBe(balance)
    expect(await h.credits.balance(RESERVE_ACCOUNT)).toBe(0)
    const saved = await h.conversations.get(owner, h.conversationId)
    expect(saved?.messages).toHaveLength(2)
    expect(saved?.messages[1]).toMatchObject({
      status: 'failed',
      content: first.json().reply,
      steps: [],
      cost: { points: 0, balance },
    })
    const entries = await h.credits.history(owner, 20)
    const replay = await h.ask()
    expect(replay.statusCode).toBe(402)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json()).toEqual(first.json())
    expect(countTokens).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(await h.credits.history(owner, 20)).toEqual(entries)
    expect((await h.conversations.get(owner, h.conversationId))?.messages).toHaveLength(2)
  },
)

it.each([
  { added: 25, balance: 550, next: 'Add points to continue.' },
  { added: 200, balance: 725, next: 'Start a new turn when ready.' },
])(
  'quotes the confirmed $balance post-refund balance rather than inferring it from the earlier hold',
  async ({ added, balance, next }) => {
    const h = await harness(525)
    countTokens.mockImplementation(async () => {
      // A separate movement during the preflight changes only this in-memory fixture.
      await h.credits.deposit({
        owner,
        points: added,
        reason: 'test:concurrent-credit',
        reference: 'concurrent-credit',
      })
      return { input_tokens: 8330 }
    })
    const response = await h.ask()
    expect(response.statusCode).toBe(402)
    expect(response.json()).toMatchObject({
      reply: `This turn needs 644 points available; you have ${balance}. No points were charged and no tools ran. ${next}`,
      cost: { points: 0, held: 525, balance },
      error: { requiredPoints: 644, availablePoints: 525 },
    })
    expect(await h.credits.balance(RESERVE_ACCOUNT)).toBe(0)
    expect(create).not.toHaveBeenCalled()
    expect(tool).not.toHaveBeenCalled()
  },
)

it('keeps later budget exhaustion as a partial success with the completed tool and actual usage', async () => {
  countTokens
    .mockResolvedValueOnce({ input_tokens: 100 })
    .mockResolvedValueOnce({ input_tokens: 100_000 })
  create.mockResolvedValue({
    content: [
      { type: 'tool_use', id: 'read-one', name: 'agent_passport', input: { agent_id: '1' } },
    ],
    usage: { input_tokens: 1000, output_tokens: 50 },
  })
  tool.mockResolvedValue({ ok: true, body: { agentId: '1' } })
  const h = await harness(5000)
  const response = await h.ask()
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({
    stoppedBy: 'budget',
    truncated: true,
    cost: { points: 49, balance: 4951 },
    steps: [{ tool: 'agent_passport', ok: true, mutating: false }],
  })
  expect(response.json().error).toBeUndefined()
  expect(response.json().reply).not.toContain('No points were charged')
  expect(create).toHaveBeenCalledTimes(1)
  expect(tool).toHaveBeenCalledTimes(1)
  expect(await h.credits.balance(RESERVE_ACCOUNT)).toBe(0)
  expect((await h.conversations.get(owner, h.conversationId))?.messages[1]?.status).toBe(
    'completed',
  )
})
