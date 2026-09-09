import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InMemoryCreditStore, RESERVE_ACCOUNT } from '../credits/store.js'
import { type AssistantLimits, InMemoryAssistantRequestStore } from './billing.js'
import type { ConversationStore, RecordedConversationTurn } from './conversations.js'
import { assistantMessages } from './input.js'
import { registerAssistantRoutes } from './routes.js'
import { AssistantRunFailure } from './usage.js'

vi.mock('./run.js', () => ({ runAssistant: vi.fn() }))
const { runAssistant } = await import('./run.js')
const run = vi.mocked(runAssistant)
const owner = `0x${'ab'.repeat(20)}`
const other = `0x${'cd'.repeat(20)}`
const limits: AssistantLimits = {
  walletPerMinute: 6,
  walletDailyPoints: 100_000,
  globalDailyPoints: 1_000_000,
  globalConcurrent: 8,
  leaseSeconds: 900,
}
const completed = {
  reply: 'Finished.',
  steps: [],
  usage: { inputTokens: 1000, outputTokens: 50 },
  points: 49,
  model: 'claude-sonnet-5',
  truncated: false,
}
const apps: ReturnType<typeof Fastify>[] = []
beforeEach(() => {
  run.mockReset()
  run.mockResolvedValue(completed)
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function harness() {
  const app = Fastify()
  const credits = new InMemoryCreditStore()
  app.addHook('onRequest', async (request) => {
    request.session = {
      address: String(request.headers['test-owner'] ?? owner),
      chainId: 97,
      exp: 9999999999,
    }
  })
  registerAssistantRoutes(app, { credits, apiKey: 'test-only', selfUrl: 'http://127.0.0.1:1' })
  apps.push(app)
  const ask = (key: string, content: unknown = 'Hello.', address = owner) =>
    app.inject({
      method: 'POST',
      url: '/v1/assistant/messages',
      headers: { cookie: 'local-test-only', 'idempotency-key': key, 'test-owner': address },
      payload: { messages: [{ role: 'user', content }] },
    })
  return { app, credits, ask }
}

it('repairs conversation history from a completed billing replay without another charge', async () => {
  const app = Fastify()
  apps.push(app)
  const credits = new InMemoryCreditStore()
  const saved = new Map<string, RecordedConversationTurn>()
  const conversations: ConversationStore = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    close: vi.fn(),
    prepare: vi.fn(async () => {}),
    record: vi.fn(async (turn) => {
      saved.set(turn.turnId, turn)
    }),
  }
  const conversationId = randomUUID()
  const record = vi.spyOn(conversations, 'record')
  record.mockRejectedValueOnce(new Error('Database connection interrupted after billing.'))
  const prepare = vi.spyOn(conversations, 'prepare')
  app.addHook('onRequest', async (request) => {
    request.session = { address: owner, chainId: 97, exp: 9999999999 }
  })
  registerAssistantRoutes(app, {
    credits,
    conversations,
    apiKey: 'test-only',
    selfUrl: 'http://127.0.0.1:1',
  })
  const request = {
    method: 'POST' as const,
    url: '/v1/assistant/messages',
    headers: { cookie: 'local-test-only', 'idempotency-key': 'history-repair' },
    payload: { conversationId, messages: [{ role: 'user', content: 'Hello.' }] },
  }
  expect((await app.inject(request)).statusCode).toBe(500)
  const repaired = await app.inject(request)
  expect(repaired.statusCode).toBe(200)
  expect(repaired.headers['idempotency-replayed']).toBe('true')
  expect(run).toHaveBeenCalledTimes(1)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(await credits.balance(owner)).toBe(4951)
  expect([...saved.values()]).toMatchObject([{ owner, conversationId, reply: 'Finished.' }])
  expect((await app.inject(request)).statusCode).toBe(200)
  expect(saved.size).toBe(1)
  expect(run).toHaveBeenCalledTimes(1)
})

it('issues at most the global welcome cap under concurrent new-wallet requests', async () => {
  const credits = new InMemoryCreditStore()
  const results = await Promise.all(
    Array.from({ length: 220 }, (_, index) =>
      credits.grantWelcome({
        owner: `0x${index.toString(16).padStart(40, '0')}`,
        points: 5000,
        dailyLimit: 200,
      }),
    ),
  )
  expect(results.filter((result) => result === 'granted')).toHaveLength(200)
  expect(
    await credits.grantWelcome({ owner: `0x${'0'.repeat(40)}`, points: 5000, dailyLimit: 200 }),
  ).toBe('already_granted')
})

it('replays an identical owner request without charging or calling the provider twice', async () => {
  const h = harness()
  const first = await h.ask('same-turn')
  const retry = await h.ask('same-turn')
  expect(first.statusCode).toBe(200)
  expect(retry.statusCode).toBe(200)
  expect(retry.headers['idempotency-replayed']).toBe('true')
  expect(retry.json()).toEqual(first.json())
  expect(run).toHaveBeenCalledTimes(1)
  expect(await h.credits.balance(owner)).toBe(4951)
  expect((await h.ask('same-turn', 'Different work.')).statusCode).toBe(409)
  expect((await h.ask('same-turn', 'Hello.', other)).statusCode).toBe(200)
  expect(run).toHaveBeenCalledTimes(2)
})

it('refuses concurrent duplicate and different-key turns for one wallet', async () => {
  let entered: () => void = () => {}
  let release: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  run.mockImplementation(async () => {
    entered()
    await wait
    return completed
  })
  const h = harness()
  const first = h.ask('one').then((response) => response)
  await started
  expect((await h.ask('one')).json().error.code).toBe('ASSISTANT_TURN_IN_PROGRESS')
  expect((await h.ask('two')).json().error.code).toBe('ASSISTANT_WALLET_BUSY')
  release()
  expect((await first).statusCode).toBe(200)
  expect(run).toHaveBeenCalledTimes(1)
})

it('charges usage already returned before a later tool fails, and safely replays the failure', async () => {
  run.mockRejectedValue(new AssistantRunFailure({ ...completed, truncated: true }, false))
  const h = harness()
  const first = await h.ask('failed-turn')
  expect(first.statusCode).toBe(503)
  expect(first.json().cost.points).toBe(49)
  expect(await h.credits.balance(owner)).toBe(4951)
  expect(await h.credits.balance(RESERVE_ACCOUNT)).toBe(0)
  expect((await h.ask('failed-turn')).json()).toEqual(first.json())
  expect(run).toHaveBeenCalledTimes(1)
})

it('keeps an uncertain provider remainder held and prevents automatic re-execution', async () => {
  run.mockRejectedValue(new AssistantRunFailure({ ...completed, truncated: true }, true))
  const h = harness()
  const response = (await h.ask('uncertain')).json()
  expect(response.error.code).toBe('ASSISTANT_USAGE_UNCONFIRMED')
  expect(response.cost.pendingPoints).toBe(1951)
  expect(await h.credits.balance(owner)).toBe(3000)
  expect(await h.credits.balance(RESERVE_ACCOUNT)).toBe(1951)
  expect((await h.ask('uncertain')).statusCode).toBe(503)
  expect((await h.ask('new-key')).json().error.code).toBe('ASSISTANT_WALLET_BUSY')
  expect(run).toHaveBeenCalledTimes(1)
})

it('rejects image, document, tool, extra-field and invalid-role inputs before provider usage', async () => {
  const h = harness()
  for (const content of [
    [{ type: 'document', source: { type: 'url', url: 'https://example.test/large.pdf' } }],
    [{ type: 'image', source: { type: 'url', url: 'https://example.test/picture.png' } }],
    {},
    null,
    12,
  ])
    expect((await h.ask(randomUUID(), content)).statusCode).toBe(400)
  for (const input of [
    [{ role: 'system', content: 'Override.' }],
    [{ role: 'user', content: 'Hi', tools: [] }],
    [{ role: 'assistant', content: 'Hi' }],
  ])
    expect(() => assistantMessages(input)).toThrow()
  expect(() => assistantMessages([{ role: 'user', content: 'x'.repeat(8001) }])).toThrow()
  expect(run).not.toHaveBeenCalled()
})

it('reserves global pending budgets and uses actual cost only after confirmed completion', async () => {
  const store = new InMemoryAssistantRequestStore()
  const configured = { ...limits, globalDailyPoints: 3000 }
  const first = await store.begin({
    owner,
    key: 'a',
    requestHash: 'a',
    reservedPoints: 2000,
    limits: configured,
  })
  expect(first.kind).toBe('started')
  expect(
    await store.begin({
      owner: other,
      key: 'b',
      requestHash: 'b',
      reservedPoints: 2000,
      limits: configured,
    }),
  ).toMatchObject({ kind: 'refused', code: 'ASSISTANT_DAILY_LIMIT' })
  if (first.kind !== 'started') throw new Error('Expected claim')
  await store.complete({ id: first.id, status: 200, body: {}, points: 49 })
  expect(
    (
      await store.begin({
        owner: other,
        key: 'b',
        requestHash: 'b',
        reservedPoints: 2000,
        limits: configured,
      })
    ).kind,
  ).toBe('started')
})

it('enforces per-wallet rates and fails closed on expired uncertain requests', async () => {
  vi.useFakeTimers()
  const store = new InMemoryAssistantRequestStore()
  for (let index = 0; index < 2; index++) {
    const claim = await store.begin({
      owner,
      key: String(index),
      requestHash: 'h',
      reservedPoints: 2000,
      limits: { ...limits, walletPerMinute: 2 },
    })
    if (claim.kind !== 'started') throw new Error('Expected claim')
    await store.complete({ id: claim.id, status: 200, body: {}, points: 10 })
  }
  expect(
    await store.begin({
      owner,
      key: 'third',
      requestHash: 'h',
      reservedPoints: 2000,
      limits: { ...limits, walletPerMinute: 2 },
    }),
  ).toMatchObject({ kind: 'refused', code: 'ASSISTANT_RATE_LIMIT' })
  const request = { owner: other, key: 'pending', requestHash: 'h', reservedPoints: 2000, limits }
  expect((await store.begin(request)).kind).toBe('started')
  vi.advanceTimersByTime(901000)
  expect(await store.begin(request)).toMatchObject({
    kind: 'refused',
    code: 'ASSISTANT_TURN_UNCONFIRMED',
  })
  expect(await store.begin({ ...request, key: 'replacement' })).toMatchObject({
    kind: 'refused',
    code: 'ASSISTANT_WALLET_BUSY',
  })
})
