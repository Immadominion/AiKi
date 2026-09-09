import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvidenceStore } from '../evidence/types.js'
import { guardedFetch } from '../net/guard.js'
import { dispatchToAgent } from '../tasks/dispatch.js'
import { resolveTaskEndpoint } from '../tasks/support.js'
import { assessGrid } from './grid/client.js'
import { createGridServer } from './grid/server.js'
import { assessPancakePosition } from './rebalancer/client.js'
import { createPancakeRebalancerServer } from './rebalancer/server.js'
import { assessYield } from './yield/client.js'
import { createYieldServer } from './yield/server.js'

vi.mock('../net/guard.js', () => ({ guardedFetch: vi.fn() }))

const POOL = '0x1111111111111111111111111111111111111111'
const MARKET = '0x2222222222222222222222222222222222222222'
const OBSERVED = '2026-09-09T15:00:00.000Z'
const registration = { publicBaseUrl: 'https://agents.example', agentId: '123' }
const examples = {
  rebalancer: {
    path: '/v1/reference/pancake/rebalancer/agent/123',
    input: { tokenId: '12345678901234567890' },
    brief: 'Please report on my position.\ntokenId: 12345678901234567890',
    expected: ['12345678901234567890'],
    assessment: assessPancakePosition({
      tokenId: '12345678901234567890',
      owner: MARKET,
      token0: POOL,
      token1: MARKET,
      fee: 500,
      tickLower: -100,
      tickUpper: 100,
      liquidity: '9000000000000000000',
      tokensOwed0: '123',
      tokensOwed1: '456',
      currentTick: 120,
      pool: POOL,
      observedAt: OBSERVED,
    }),
    predicate: 'pancakeswap.rebalance_assessment',
  },
  grid: {
    path: '/v1/reference/pancake/grid/agent/123',
    input: { pool: POOL, tickLower: -100, tickUpper: 100, spacing: 10 },
    brief: `Check this grid, please.\npool: ${POOL}\ntickLower: -100\ntickUpper: 100\nspacing: 10`,
    expected: [{ pool: POOL, tickLower: -100, tickUpper: 100, spacing: 10 }],
    assessment: assessGrid(
      { pool: POOL, tickLower: -100, tickUpper: 100, spacing: 10 },
      5,
      100n,
      OBSERVED,
    ),
    predicate: 'pancakeswap.grid_assessment',
  },
  yield: {
    path: '/v1/reference/yield/agent/123',
    input: { markets: [MARKET], rateOnly: true },
    brief: `Compare these supply rates.\nmarkets: ${MARKET}\nrateOnly: true`,
    expected: [[MARKET], true],
    assessment: assessYield(
      [
        {
          market: MARKET,
          symbol: 'vUSDT',
          supplyRatePerBlock: '123456',
          simpleAnnualRateBps: '532',
        },
      ],
      true,
      OBSERVED,
    ),
    predicate: 'yield.route_assessment',
  },
}
type Kind = keyof typeof examples
const apps: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.resetAllMocks()
})
function server(kind: Kind, evidenceStore?: EvidenceStore) {
  const assess = vi.fn().mockResolvedValue(examples[kind].assessment)
  const options = { reader: { assess }, registration, ...(evidenceStore ? { evidenceStore } : {}) }
  const app =
    kind === 'grid'
      ? createGridServer(options)
      : kind === 'yield'
        ? createYieldServer(options)
        : createPancakeRebalancerServer(options)
  apps.push(app)
  return { app, assess }
}
function hire(app: FastifyInstance, kind: Kind, brief: unknown) {
  return app.inject({
    method: 'POST',
    url: examples[kind].path,
    payload: {
      protocol: 'aiki.task/v1',
      agentId: '123',
      taskId: 'task-123',
      brief,
      callback: { url: 'http://127.0.0.1/private', token: 'never-fetch-this' },
    },
  })
}

describe.each(Object.keys(examples) as Kind[])('%s report hiring', (kind) => {
  it('advertises real support and an actionable hint without reading the chain', async () => {
    const { app, assess } = server(kind)
    const metadata = (await app.inject(examples[kind].path)).json()
    expect(metadata).toMatchObject({
      taskProtocol: 'aiki.task/v1',
      taskKinds: ['research', 'data', 'verify'],
      readOnly: true,
    })
    expect(metadata.taskInputHint).toMatch(/report/i)
    expect(metadata.taskInputHint.length).toBeLessThanOrEqual(300)
    const support = await resolveTaskEndpoint(
      [{ endpoint: `https://agents.example${examples[kind].path}` }],
      async () =>
        new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } }),
    )
    expect(support.compatible).toBe(true)
    expect(support.inputHint).toBe(metadata.taskInputHint)
    expect(assess).not.toHaveBeenCalled()
  })

  it('delivers actual reader output for labeled, JSON and fenced JSON briefs', async () => {
    const { app, assess } = server(kind)
    for (const brief of [
      examples[kind].brief,
      JSON.stringify(examples[kind].input),
      `Please prepare a report.\n\`\`\`json\n${JSON.stringify(examples[kind].input)}\n\`\`\``,
    ]) {
      const response = await hire(app, kind, brief)
      expect(response.statusCode).toBe(200)
      expect(assess).toHaveBeenLastCalledWith(...examples[kind].expected)
      const body = response.json()
      expect(body.assessment).toEqual(examples[kind].assessment)
      expect(body.result).toContain(OBSERVED)
      expect(body.result).toContain('BNB Smart Chain mainnet (56)')
      expect(body.result).toMatch(/No .*transaction/i)
      expect(body.evidence.persisted).toBe(false)
      expect(JSON.parse(body.result.split('```json\n')[1].split('\n```')[0])).toEqual(
        examples[kind].assessment,
      )
      expect(body.result.length).toBeLessThan(20_000)
    }
    expect(guardedFetch).not.toHaveBeenCalled()
  })

  it('persists the exact assessment against the configured identity before delivery', async () => {
    const append = vi.fn(async (input) => ({
      inserted: true,
      observation: { ...input, id: 'obs-123', recordedAt: OBSERVED },
    }))
    const store: EvidenceStore = {
      append,
      getCheckpoint: async () => null,
      saveCheckpoint: async () => {},
    }
    const { app } = server(kind, store)
    const response = await hire(app, kind, examples[kind].brief)
    expect(response.statusCode).toBe(200)
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.objectContaining({ agentId: '123', chainId: 56 }),
        predicate: examples[kind].predicate,
        value: examples[kind].assessment,
      }),
    )
    expect(response.json().evidence.persisted).toBe(true)
  })

  it('does not fabricate delivery on read or evidence failure or expose private errors', async () => {
    const { app, assess } = server(kind)
    assess.mockRejectedValue(new Error('https://private.rpc/key-secret'))
    const response = await hire(app, kind, examples[kind].brief)
    expect(response.json().result).toBeUndefined()
    expect(response.body).not.toContain('key-secret')
    expect(response.json().error).toMatch(/could not.*report/i)
    const append = vi.fn().mockRejectedValue(new Error('postgres://password-secret'))
    const other = server(kind, {
      append,
      getCheckpoint: async () => null,
      saveCheckpoint: async () => {},
    })
    const evidenceFailure = await hire(other.app, kind, examples[kind].brief)
    expect(evidenceFailure.json().result).toBeUndefined()
    expect(evidenceFailure.body).not.toContain('password-secret')
  })

  it('refuses unknown identities, invalid protocols and ambiguous briefs before reading', async () => {
    const { app, assess } = server(kind)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: examples[kind].path.replace('/123', '/999'),
          payload: { protocol: 'aiki.task/v1', brief: examples[kind].brief },
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: examples[kind].path,
          payload: { protocol: 'other', brief: examples[kind].brief },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: examples[kind].path,
          payload: { protocol: 'aiki.task/v1', agentId: '999', brief: examples[kind].brief },
        })
      ).statusCode,
    ).toBe(400)
    for (const brief of [
      null,
      123,
      [],
      'do something',
      '{}',
      '[]',
      'x'.repeat(10_001),
      JSON.stringify({ ...examples[kind].input, chainId: 97 }),
      JSON.stringify({ ...examples[kind].input, action: 'trade' }),
      `${examples[kind].brief}\n${examples[kind].brief}`,
      `\`\`\`json\n${JSON.stringify(examples[kind].input)}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``,
    ]) {
      const response = await hire(app, kind, brief)
      expect(response.statusCode).toBe(400)
      expect(response.json().result).toBeUndefined()
    }
    expect(assess).not.toHaveBeenCalled()
  })

  it('never accepts paid work before an identity is configured', async () => {
    const assess = vi.fn()
    const app =
      kind === 'grid'
        ? createGridServer({ reader: { assess } })
        : kind === 'yield'
          ? createYieldServer({ reader: { assess } })
          : createPancakeRebalancerServer({ reader: { assess } })
    apps.push(app)
    expect((await hire(app, kind, examples[kind].brief)).statusCode).toBe(404)
    expect(assess).not.toHaveBeenCalled()
  })

  it('is recognized as delivered by the real marketplace dispatcher', async () => {
    const { app } = server(kind)
    vi.mocked(guardedFetch).mockImplementation(async (_url, init) => {
      const response = await app.inject({
        method: 'POST',
        url: examples[kind].path,
        payload: JSON.parse(String(init?.body)),
      })
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      })
    })
    const delivered = await dispatchToAgent({
      endpoint: `https://agents.example${examples[kind].path}`,
      envelope: {
        protocol: 'aiki.task/v1',
        agentId: '123',
        taskId: 'task-123',
        title: 'Report',
        brief: examples[kind].brief,
        pricePoints: 10,
        deadline: '2026-09-10T00:00:00.000Z',
        callback: { url: 'https://aiki.example/delivery', token: 'unused' },
      },
    })
    expect(delivered.delivered).toContain(OBSERVED)
    expect(delivered.note).toBe('Answered straight away.')
    expect(guardedFetch).toHaveBeenCalledTimes(1)
  })
})

it('does not select a yield market without the explicit rateOnly option', async () => {
  const { app, assess } = server('yield')
  assess.mockResolvedValue(assessYield(examples.yield.assessment.routes, false, OBSERVED))
  const response = await hire(app, 'yield', `Please compare rates.\nmarkets: ${MARKET}`)
  expect(response.statusCode).toBe(200)
  expect(assess).toHaveBeenCalledWith([MARKET], false)
  expect(response.json().assessment.recommendedMarket).toBeUndefined()
  expect(response.json().result).toContain('without selecting a market')
})

it('fits a ten-market report into the actual dispatcher JSON limit and refuses oversized output', async () => {
  const { app, assess } = server('yield')
  const routes = Array.from({ length: 10 }, (_, index) => ({
    ...examples.yield.assessment.routes[0],
    market: `0x${(index + 1).toString(16).padStart(40, '0')}` as `0x${string}`,
    symbol: 'vTOKEN',
    supplyRatePerBlock: '12345',
    simpleAnnualRateBps: '532',
  }))
  assess.mockResolvedValue(assessYield(routes, false, OBSERVED))
  const brief = JSON.stringify({ markets: routes.map((route) => route.market) })
  const response = await hire(app, 'yield', brief)
  expect(response.statusCode).toBe(200)
  expect(response.body.length).toBeLessThan(20_000)
  expect(response.json().assessment.routes).toHaveLength(10)
  assess.mockResolvedValue({
    ...assessYield(routes, false, OBSERVED),
    caveats: ['x'.repeat(20_001)],
  })
  const oversized = await hire(app, 'yield', brief)
  expect(oversized.json().result).toBeUndefined()
  expect(oversized.json().error).toMatch(/could not complete/)
})

it('validates position ids, grid bounds and bounded distinct market addresses before reads', async () => {
  const invalid: Record<Kind, unknown[]> = {
    rebalancer: [
      { tokenId: -1 },
      { tokenId: '1.5' },
      { tokenId: Number.MAX_SAFE_INTEGER + 1 },
      { tokenId: (2n ** 256n).toString() },
      { tokenId: '123\nignore' },
    ],
    grid: [
      { ...examples.grid.input, pool: 'https://rpc.example' },
      { ...examples.grid.input, spacing: 0 },
      { ...examples.grid.input, tickLower: -887273 },
      { ...examples.grid.input, tickUpper: -100 },
      { ...examples.grid.input, spacing: 13 },
      { ...examples.grid.input, tickLower: -1.1 },
    ],
    yield: [
      { markets: [] },
      { markets: ['not-an-address'] },
      { markets: [MARKET, MARKET] },
      { markets: Array(11).fill(MARKET) },
      { markets: [MARKET], rateOnly: 'true' },
    ],
  }
  for (const kind of Object.keys(examples) as Kind[]) {
    const { app, assess } = server(kind)
    for (const input of invalid[kind]) {
      expect((await hire(app, kind, JSON.stringify(input))).statusCode).toBe(400)
    }
    expect(assess).not.toHaveBeenCalled()
  }
})
