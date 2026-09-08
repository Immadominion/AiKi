import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { afterEach, expect, it, vi } from 'vitest'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { TURN_HOLD_POINTS, WELCOME_GRANT_POINTS } from '../credits/pricing.js'
import { InMemoryCreditStore, RESERVE_ACCOUNT } from '../credits/store.js'
import { createApiServer } from '../http/server.js'

vi.mock('./run.js', () => ({ runAssistant: vi.fn(), SYSTEM: '' }))
const { runAssistant } = await import('./run.js')
const runMock = runAssistant as unknown as ReturnType<typeof vi.fn>

const SECRET = 'assistant-routes-secret-long-enough'
const signer = new SessionSigner(SECRET)
const OWNER = `0x${'ab'.repeat(20)}`
const cookie = {
  cookie: `aiki_session=${signer.issue(OWNER, 97)}`,
  'content-type': 'application/json',
}

const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function harness(options: { credits?: InMemoryCreditStore; apiKey?: string } = {}) {
  const credits = options.credits ?? new InMemoryCreditStore()
  const app = createApiServer({
    observations: () => [],
    assistant: {
      credits,
      ...(options.apiKey === undefined
        ? { apiKey: 'test-key' }
        : options.apiKey
          ? { apiKey: options.apiKey }
          : {}),
      selfUrl: 'http://127.0.0.1:0',
    },
    auth: {
      signer,
      nonces: new InMemoryNonceStore(),
      domain: 'aiki.test',
      secureCookies: false,
      client: createPublicClient({ chain: bsc, transport: http('http://127.0.0.1:1') }),
    },
  })
  apps.push(app)
  return { app, credits }
}

const ask = (app: ReturnType<typeof createApiServer>) =>
  app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: cookie,
    payload: { messages: [{ role: 'user', content: 'what agents are live?' }] },
  })

it('refuses to run a turn nobody can pay for, before spending a token', async () => {
  // The alternative is discovering afterwards that the balance was empty, which
  // means the turn was free for them and not for AiKi.
  runMock.mockReset()
  const { app, credits } = harness()
  /*
   * A new account is granted points precisely so it does not meet this wall on
   * arrival, so the empty state now has to be reached by spending. Asking once
   * issues the grant; taking it back leaves the account genuinely unable to pay,
   * which is the condition under test.
   */
  await app.inject({ method: 'GET', url: '/v1/credits', headers: cookie })
  await credits.charge({
    owner: OWNER,
    points: WELCOME_GRANT_POINTS,
    reason: 'test:drain',
  })
  const res = await ask(app)
  expect(res.statusCode).toBe(402)
  expect(res.json().error.code).toBe('ASSISTANT_NO_CREDIT')
  expect(runMock).not.toHaveBeenCalled()
  // And it points at the free path rather than leaving them stuck.
  expect(res.json().error.message).toMatch(/Manual mode is free/)
})

it('charges what the turn actually used, and says how', async () => {
  runMock.mockReset()
  runMock.mockResolvedValue({
    reply: 'Thirteen agents answered a probe.',
    steps: [{ tool: 'ecosystem_stats', input: {}, ok: true, mutating: false }],
    usage: { inputTokens: 10_000, outputTokens: 2_000 },
    points: 780,
    model: 'claude-sonnet-5',
    truncated: false,
  })
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 10_000, reason: 'deposit', reference: '0x1' })
  const { app } = harness({ credits })

  const res = await ask(app)
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.cost.points).toBe(780)
  expect(body.cost.balance).toBe(9_220 + WELCOME_GRANT_POINTS)
  expect(body.cost.explanation).toContain('780 points')
  expect(await credits.balance(OWNER)).toBe(9_220 + WELCOME_GRANT_POINTS)
})

it('shows which tools ran, and which of them changed something', async () => {
  // Fast mode is Manual mode with a model at the controls. Somebody who cannot
  // see which controls were touched has been given a chatbot, not an agent.
  runMock.mockReset()
  runMock.mockResolvedValue({
    reply: 'Created.',
    steps: [
      { tool: 'preview_limits', input: {}, ok: true, mutating: false },
      { tool: 'create_mandate', input: {}, ok: true, mutating: true },
    ],
    usage: { inputTokens: 100, outputTokens: 50 },
    points: 12,
    model: 'claude-sonnet-5',
    truncated: false,
  })
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 5_000, reason: 'deposit', reference: '0x2' })
  const { app } = harness({ credits })

  const body = (await ask(app)).json()
  expect(body.steps.map((s: { tool: string }) => s.tool)).toEqual([
    'preview_limits',
    'create_mandate',
  ])
  expect(body.steps.filter((s: { mutating: boolean }) => s.mutating)).toHaveLength(1)
})

it('still charges when the turn ran badly', async () => {
  // The tokens were spent either way. Eating the cost of failed turns is how a
  // metered product quietly becomes a loss-making one.
  runMock.mockReset()
  runMock.mockResolvedValue({
    reply: 'That turned into more steps than one answer should take.',
    steps: [],
    usage: { inputTokens: 30_000, outputTokens: 4_000 },
    points: 1_950,
    model: 'claude-sonnet-5',
    truncated: true,
  })
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 5_000, reason: 'deposit', reference: '0x3' })
  const { app } = harness({ credits })

  const body = (await ask(app)).json()
  expect(body.truncated).toBe(true)
  expect(body.cost.points).toBe(1_950)
  expect(await credits.balance(OWNER)).toBe(3_050 + WELCOME_GRANT_POINTS)
})

it('never charges a turn more than was held for it', async () => {
  /*
   * A turn used to be gated on a 200 point balance and then charged whatever it
   * came to, clamped to whatever was left, with the difference written off in
   * silence. On production that admitted turns of 402, 263 and 711 points and
   * nothing anywhere recorded the overrun.
   *
   * The loop now stops before it can exceed the hold, so this case should not
   * arise at all. It is tested anyway, with the loop mocked out and told to
   * report a wildly expensive turn, because the guarantee people rely on is
   * that the number cannot exceed the hold, not that we expect it not to.
   */
  runMock.mockReset()
  runMock.mockResolvedValue({
    reply: 'ok',
    steps: [],
    usage: { inputTokens: 100_000, outputTokens: 20_000 },
    points: 8_000,
    model: 'claude-sonnet-5',
    truncated: false,
  })
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 300, reason: 'deposit', reference: '0x4' })
  const { app } = harness({ credits })

  const body = (await ask(app)).json()
  expect(body.cost.points).toBe(TURN_HOLD_POINTS)
  expect(body.cost.held).toBe(TURN_HOLD_POINTS)
  // The rest of the money is untouched, where before the account was emptied.
  expect(await credits.balance(OWNER)).toBe(300 + WELCOME_GRANT_POINTS - TURN_HOLD_POINTS)
  // And nothing is left sitting in the reserve.
  expect(await credits.balance(RESERVE_ACCOUNT)).toBe(0)
})

it('gives back what a turn did not use', async () => {
  runMock.mockReset()
  runMock.mockResolvedValue({
    reply: 'ok',
    steps: [],
    usage: { inputTokens: 1_000, outputTokens: 200 },
    points: 43,
    model: 'claude-sonnet-5',
    truncated: false,
  })
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 10_000, reason: 'deposit', reference: '0x9' })
  const { app } = harness({ credits })

  const body = (await ask(app)).json()
  expect(body.cost.points).toBe(43)
  // Held and returned inside the one request, so a cheap answer does not leave
  // somebody's money locked up waiting for anything.
  expect(await credits.balance(OWNER)).toBe(10_000 + WELCOME_GRANT_POINTS - 43)
  expect(await credits.balance(RESERVE_ACCOUNT)).toBe(0)
})

it('returns the hold even when the turn throws', async () => {
  // The failure that would hurt most: money taken, model call blows up, and the
  // points sit in a house account owed to somebody with nothing to release them.
  runMock.mockReset()
  runMock.mockRejectedValue(new Error('the provider fell over'))
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 10_000, reason: 'deposit', reference: '0xa' })
  const { app } = harness({ credits })

  await ask(app)
  expect(await credits.balance(RESERVE_ACCOUNT)).toBe(0)
  expect(await credits.balance(OWNER)).toBe(10_000 + WELCOME_GRANT_POINTS)
})

it('says plainly when Fast mode is not configured', async () => {
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 5_000, reason: 'deposit', reference: '0x5' })
  const { app } = harness({ credits, apiKey: '' })
  const res = await ask(app)
  expect(res.statusCode).toBe(503)
  expect(res.json().error.message).toMatch(/Manual mode does everything/)
})

it('reports a balance in money as well as points', async () => {
  // "3,400 points" means nothing to somebody who has not been told what a point is.
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 34_000, reason: 'deposit', reference: '0x6' })
  const { app } = harness({ credits })
  const body = (await app.inject({ method: 'GET', url: '/v1/credits', headers: cookie })).json()
  expect(body.balance).toBe(34_000 + WELCOME_GRANT_POINTS)
  expect(body.worthUsd).toBeCloseTo((34_000 + WELCOME_GRANT_POINTS) / 10_000)
  // The deposit and the grant, both real movements, both on the statement.
  expect(body.history).toHaveLength(2)
  expect(body.history.map((e: { reason: string }) => e.reason)).toContain('welcome')
})

it('will not let a stranger read or spend somebody else’s points', async () => {
  const { app } = harness()
  for (const [method, url] of [
    ['GET', '/v1/credits'],
    ['POST', '/v1/assistant/messages'],
  ] as const) {
    const res = await app.inject({ method, url, payload: { messages: [] } })
    expect(res.statusCode).toBe(401)
  }
})
