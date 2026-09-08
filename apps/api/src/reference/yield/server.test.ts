import { afterEach, describe, expect, it } from 'vitest'
import type { YieldAssessment } from './client.js'
import { createYieldServer } from './server.js'

const assessment: YieldAssessment = {
  category: 'yield_optimisation',
  assessmentVersion: 'venus-yield/v1',
  routes: [
    {
      market: '0x0000000000000000000000000000000000000002',
      symbol: 'vUSDT',
      supplyRatePerBlock: '1',
      simpleAnnualRateBps: '700',
    },
  ],
  recommendedMarket: '0x0000000000000000000000000000000000000002',
  recommendation: 'RATE_ONLY_CANDIDATE',
  observedAt: '2026-08-29T00:00:00.000Z',
  caveats: [],
}
const apps: ReturnType<typeof createYieldServer>[] = []
function server(registration?: { publicBaseUrl: string; agentId: string }) {
  const app = createYieldServer({
    reader: { assess: async () => assessment },
    ...(registration ? { registration } : {}),
  })
  apps.push(app)
  return app
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('Yield reference server', () => {
  it('serves a registration file whose endpoint carries the agent id', async () => {
    const app = server({ publicBaseUrl: 'https://api.example', agentId: '78' })
    const manifest = await app.inject('/v1/reference/yield/manifest.json')
    expect(manifest.statusCode).toBe(200)
    expect(manifest.json().services[0].endpoint).toBe(
      'https://api.example/v1/reference/yield/agent/78',
    )
    expect((await app.inject('/v1/reference/yield/icon.svg')).statusCode).toBe(200)
  })

  it('answers for the identity it owns and refuses one it does not', async () => {
    const app = server({ publicBaseUrl: 'https://api.example', agentId: '78' })
    expect((await app.inject('/v1/reference/yield/agent/999999999')).statusCode).toBe(404)
    const described = await app.inject('/v1/reference/yield/agent/78')
    expect(described.json().category).toBe('yield_optimisation')
    const answered = await app.inject(
      '/v1/reference/yield/agent/78?markets=0x0000000000000000000000000000000000000002',
    )
    expect(answered.json().assessment.recommendation).toBe('RATE_ONLY_CANDIDATE')
  })

  it('publishes no identity until one is configured', async () => {
    const app = server()
    expect((await app.inject('/v1/reference/yield/manifest.json')).statusCode).toBe(503)
    expect((await app.inject('/v1/reference/yield/agent/78')).statusCode).toBe(404)
    expect((await app.inject('/v1/reference/yield')).statusCode).toBe(200)
  })
})
