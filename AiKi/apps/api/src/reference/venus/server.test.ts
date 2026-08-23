import { afterEach, describe, expect, it } from 'vitest'
import { createVenusReferenceServer } from './server.js'
import type { VenusHealthAssessment } from './types.js'

const assessment: VenusHealthAssessment = {
  account: '0x1111111111111111111111111111111111111111', protocol: 'Venus', category: 'health_factor', assessmentVersion: 'venus-health/v1', observedAt: '2026-08-22T00:00:00.000Z', status: 'NO_DEBT', minimumHealthFactor: '1.25', supplied: { amount: '0', asset: 'USD', decimals: 18 }, adjustedCollateral: { amount: '0', asset: 'USD', decimals: 18 }, borrowed: { amount: '0', asset: 'USD', decimals: 18 }, controllerLiquidity: { amount: '0', asset: 'USD', decimals: 18 }, controllerShortfall: { amount: '0', asset: 'USD', decimals: 18 }, positions: [], methodology: 'test', consistency: { verified: true, detail: 'test' }, caveats: [],
}
const apps: ReturnType<typeof createVenusReferenceServer>[] = []
function server() {
  const app = createVenusReferenceServer({ reader: { assess: async () => assessment }, registration: { publicBaseUrl: 'https://guardian.example', agentId: '123' } })
  apps.push(app)
  return app
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

describe('Venus reference server', () => {
  it('serves an ERC-8004 registration file and matching reciprocal proof', async () => {
    const app = server()
    const manifest = await app.inject('/v1/reference/venus/manifest.json')
    const proof = await app.inject('/.well-known/agent-registration.json')
    expect(manifest.statusCode).toBe(200)
    expect(manifest.json().services[0].endpoint).toBe('https://guardian.example/v1/reference/venus/agent/123')
    expect(proof.json().registrations[0].agentId).toBe('123')
  })

  it('rejects an altered agent id and serves a read-only assessment for the configured identity', async () => {
    const app = server()
    expect((await app.inject('/v1/reference/venus/agent/999')).statusCode).toBe(404)
    const response = await app.inject('/v1/reference/venus/agent/123?account=0x1111111111111111111111111111111111111111')
    expect(response.statusCode).toBe(200)
    expect(response.json().assessment.status).toBe('NO_DEBT')
  })
})
