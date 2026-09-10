import { afterEach, describe, expect, it, vi } from 'vitest'
import { stoppedReply } from './outcomes.js'
import { SYSTEM } from './run.js'
import { runStrategyTool, STRATEGY_TOOLS } from './strategy-tools.js'
import { MUTATING, runTool, TOOLS } from './tools.js'

const address = (b: string) => `0x${b.repeat(20)}`,
  hash = (b: string) => `0x${b.repeat(32)}`
const owner = address('11'),
  registry = address('22'),
  id = '11111111-1111-4111-8111-111111111111'
const ctx = { baseUrl: 'https://api.example', cookie: 'local-test-session', sessionAddress: owner }
const config = () => ({
  available: true,
  chainId: 56,
  configurationHash: hash('aa'),
  manager: address('33'),
  executor: address('44'),
  bindingEnforcer: address('55'),
  expiryEnforcer: address('56'),
  kinds: ['yield', 'grid', 'lp'],
  schedulerReady: true,
  factories: Object.fromEntries(
    ['yield', 'grid', 'lp'].map((kind, i) => [
      kind,
      { address: address(String(66 + i)), runtimeCodeHash: hash('bb') },
    ]),
  ),
  agents: {
    yield: { agentId: '315946', registry, chainId: 56 },
    grid: { agentId: '315945', registry, chainId: 56 },
    lp: { agentId: '315944', registry, chainId: 56 },
  },
})
const setup = () => ({
  id,
  owner,
  kind: 'yield',
  chainId: 56,
  status: 'PAUSED',
  readiness: {
    ready: false,
    schedulerReady: true,
    reasons: ['Explicitly resume the owner vault.'],
  },
  authorization: {
    signedAt: '2026-09-10T00:00:00Z',
    digest: hash('aa'),
    signature: 'PRIVATE_SIGNATURE',
  },
  prepared: { unsignedTransaction: { data: 'NOT_FOR_MODEL' } },
  watch: {
    status: 'PAUSED',
    nextRunAt: '2026-09-10T00:00:00Z',
    lastDecision: { reason: 'Waiting for the owner.', at: '2026-09-10T00:00:00Z' },
    lastTransactionHash: hash('bb'),
  },
})
function fixture() {
  const current = config(),
    status = setup(),
    responses = new Map<string, { ok: boolean; body: unknown }>([
      ['/v1/strategies/config', { ok: true, body: current }],
      ['/v1/strategies', { ok: true, body: { setups: [status] } }],
      [`/v1/strategies/${id}`, { ok: true, body: status }],
      ...Object.values(current.agents).map(
        (agent) =>
          [
            `/v1/agents/${agent.agentId}/passport`,
            {
              ok: true,
              body: {
                agentId: agent.agentId,
                chainId: 56,
                registry,
                liveness: 'LIVE',
                identity: { registrationFile: { reciprocalProofVerified: true } },
              },
            },
          ] as [string, { ok: boolean; body: unknown }],
      ),
    ])
  const read = vi.fn(async (path: string) => {
    const result = responses.get(path)
    if (!result) throw new Error('Unexpected private endpoint')
    return result
  })
  const run = (name: string, args: Record<string, unknown> = {}) =>
    runStrategyTool(name, args, owner, read)
  return { current, status, responses, read, run }
}
afterEach(() => vi.unstubAllGlobals())
describe('Fast read-only strategy discovery', () => {
  it('exposes only read tools without altering the mutating tool set', () => {
    for (const tool of STRATEGY_TOOLS) {
      expect(TOOLS.some((item) => item.name === tool.name)).toBe(true)
      expect(MUTATING.has(tool.name)).toBe(false)
      expect(tool.input_schema.additionalProperties).toBe(false)
    }
  })
  it.each(['yield', 'grid', 'lp'])(
    'links only the configured exact live reciprocal %s identity',
    async (kind) => {
      const f = fixture(),
        result = await f.run('strategy_setup_link', { kind })
      expect(result).toMatchObject({
        ok: true,
        body: {
          kind,
          chainId: 56,
          href: `/strategy/${kind}`,
          navigationOnly: true,
          available: true,
          schedulerReady: true,
        },
      })
      expect(result).not.toHaveProperty('action')
      expect(f.read.mock.calls).toHaveLength(2)
    },
  )
  it('keeps unavailable deployments and scheduler truthful without inventing a factory', async () => {
    const f = fixture()
    f.responses.set('/v1/strategies/config', {
      ok: true,
      body: { available: false, chainId: 56, agents: f.current.agents },
    })
    expect(await f.run('strategy_config')).toMatchObject({
      ok: true,
      body: { available: false, schedulerReady: false },
    })
    expect(await f.run('strategy_setup_link', { kind: 'yield' })).toMatchObject({
      ok: true,
      body: {
        href: '/strategy/yield',
        available: false,
        schedulerReady: false,
        notice: expect.stringContaining('not available'),
      },
    })
  })
  it.each(['agent', 'registry', 'chain', 'liveness', 'reciprocal', 'missing-mapping'] as const)(
    'refuses %s mismatch with no navigation fallback',
    async (mode) => {
      const f = fixture(),
        passport = f.responses.get('/v1/agents/315946/passport')?.body as Record<string, unknown>
      if (mode === 'agent') passport.agentId = '315944'
      if (mode === 'registry') passport.registry = address('ab')
      if (mode === 'chain') passport.chainId = 97
      if (mode === 'liveness') passport.liveness = 'DEGRADED'
      if (mode === 'reciprocal')
        passport.identity = { registrationFile: { reciprocalProofVerified: false } }
      if (mode === 'missing-mapping') f.current.agents = {} as typeof f.current.agents
      const result = await f.run('strategy_setup_link', { kind: 'yield' })
      expect(result?.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('href')
    },
  )
  it.each(['absent', 'chain', 'fake-ready', 'missing-factory', 'rpc'] as const)(
    'fails closed on %s configuration',
    async (mode) => {
      const f = fixture()
      if (mode === 'absent')
        f.responses.set('/v1/strategies/config', { ok: false, body: { error: 'PRIVATE_RPC_URL' } })
      if (mode === 'chain') f.current.chainId = 97
      if (mode === 'fake-ready') Object.assign(f.current, { available: 'true' })
      if (mode === 'missing-factory') f.current.factories = {}
      if (mode === 'rpc') f.read.mockRejectedValue(new Error('PRIVATE_RPC_URL'))
      const result = await f.run('strategy_config')
      expect(result?.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('PRIVATE_RPC_URL')
    },
  )
  it.each([
    ['strategy_config', { owner }],
    ['my_strategies', { owner }],
    ['strategy_setup_link', { kind: 'yield', factory: address('ab') }],
    ['strategy_setup_link', { kind: '../../credits' }],
    ['strategy_status', { setup_id: '../account' }],
    ['strategy_status', { setup_id: id, start: true }],
  ])('rejects model-supplied action/URL/owner arguments for %s before HTTP', async (name, args) => {
    const f = fixture()
    expect((await f.run(String(name), args as Record<string, unknown>))?.ok).toBe(false)
    expect(f.read).not.toHaveBeenCalled()
  })
  it('forwards the session to GET no-store endpoints only, never signing or funding', async () => {
    const f = fixture(),
      fetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(init?.method ?? 'GET').toBe('GET')
        expect(init?.body).toBeUndefined()
        expect(init?.cache).toBe('no-store')
        expect(init?.headers).toMatchObject({ cookie: ctx.cookie, 'x-aiki-wallet-address': owner })
        const result = await f.read(new URL(url).pathname)
        return new Response(JSON.stringify(result.body), { status: result.ok ? 200 : 503 })
      })
    vi.stubGlobal('fetch', fetch)
    expect((await runTool(ctx, 'strategy_setup_link', { kind: 'yield' })).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
describe('bounded owner status and honest budget-stop handoff', () => {
  it('returns recorded state and readiness without signatures, unsigned calldata or funding addresses', async () => {
    const f = fixture(),
      result = await f.run('strategy_status', { setup_id: id })
    expect(result).toMatchObject({
      ok: true,
      body: {
        setupId: id,
        status: 'PAUSED',
        mandateSigned: true,
        readiness: { ready: false },
        activity: { lastTransactionHash: hash('bb') },
      },
    })
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain('PRIVATE_SIGNATURE')
    expect(encoded).not.toContain('NOT_FOR_MODEL')
    expect(encoded).not.toContain(owner)
  })
  it('bounds lists and refuses unsigned or different owners', async () => {
    const f = fixture()
    f.responses.set('/v1/strategies', {
      ok: true,
      body: { setups: Array.from({ length: 100 }, () => setup()) },
    })
    expect(await f.run('my_strategies')).toMatchObject({
      ok: true,
      body: { hasMore: true, setups: expect.any(Array) },
    })
    const result = await f.run('my_strategies')
    if (!result) throw new Error('Missing result')
    expect((result.body as { setups: unknown[] }).setups).toHaveLength(12)
    f.read.mockClear()
    expect((await runStrategyTool('my_strategies', {}, undefined, f.read))?.ok).toBe(false)
    expect(f.read).not.toHaveBeenCalled()
    f.status.owner = address('ab')
    expect((await f.run('strategy_status', { setup_id: id }))?.ok).toBe(false)
  })
  it('does not turn status errors into an empty list or nonexistent strategy', async () => {
    const f = fixture()
    f.responses.set('/v1/strategies', { ok: false, body: { error: { message: 'PRIVATE' } } })
    const result = await f.run('my_strategies')
    expect(result?.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('preserves only an allowlisted navigation URL without another paid round or false Work CTA', async () => {
    const f = fixture(),
      result = await f.run('strategy_setup_link', { kind: 'yield' })
    if (!result) throw new Error('Missing result')
    const reply = stoppedReply('budget', [
      { tool: 'strategy_setup_link', mutating: false, ...result },
    ])
    expect(reply).toContain('[Review yield setup](/strategy/yield)')
    expect(reply).toContain('No wallet action')
    expect(reply).not.toContain('/work')
    const malformed = stoppedReply('budget', [
      {
        tool: 'strategy_setup_link',
        mutating: false,
        ok: true,
        body: { kind: 'yield', navigationOnly: true, href: 'https://evil.example' },
      },
    ])
    expect(malformed).not.toContain('evil.example')
    expect(malformed).not.toContain('/strategy/yield')
  })
  it('system guidance distinguishes paid reports from verified strategies and requires explicit owner confirmations', () => {
    expect(SYSTEM).toContain('Do not call these report-only when verified setup is available')
    expect(SYSTEM).toContain('No strategy\n  tool here creates or changes a setup')
    expect(SYSTEM).toContain('Never use create_mandate, hire or watch_position as a substitute')
    expect(SYSTEM).toContain('recorded scheduler state, not proof of a trade')
  })
})
