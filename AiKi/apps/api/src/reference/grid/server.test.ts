import { afterEach, describe, expect, it } from 'vitest'
import type { GridAssessment } from './client.js'
import { createGridServer } from './server.js'

const assessment: GridAssessment = {
  pool: '0x0000000000000000000000000000000000000001',
  tickLower: -100,
  tickUpper: 100,
  spacing: 10,
  category: 'grid_trading',
  assessmentVersion: 'pancake-v3-grid/v1',
  currentTick: 5,
  state: 'IN_GRID',
  recommendation: 'WAIT',
  poolLiquidity: '1',
  observedAt: '2026-08-29T00:00:00.000Z',
  caveats: [],
}
const apps: ReturnType<typeof createGridServer>[] = []
function server(registration?: { publicBaseUrl: string; agentId: string }) {
  const app = createGridServer({
    reader: { assess: async () => assessment },
    ...(registration ? { registration } : {}),
  })
  apps.push(app)
  return app
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('Grid reference server', () => {
  it('serves a registration file whose endpoint carries the agent id', async () => {
    const app = server({ publicBaseUrl: 'https://api.example', agentId: '77' })
    const manifest = await app.inject('/v1/reference/pancake/grid/manifest.json')
    expect(manifest.statusCode).toBe(200)
    expect(manifest.json().services[0].endpoint).toBe(
      'https://api.example/v1/reference/pancake/grid/agent/77',
    )
    expect(manifest.json().image).toBe('https://api.example/v1/reference/pancake/grid/icon.svg')
    expect((await app.inject('/v1/reference/pancake/grid/icon.svg')).statusCode).toBe(200)
    expect(
      (await app.inject('/.well-known/agent-registration.json')).json().registrations[0],
    ).toEqual({
      agentId: '77',
      agentRegistry: 'eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    })
  })

  it('answers for the identity it owns and refuses one it does not', async () => {
    const app = server({ publicBaseUrl: 'https://api.example', agentId: '77' })
    expect((await app.inject('/v1/reference/pancake/grid/agent/999999999')).statusCode).toBe(404)
    const described = await app.inject('/v1/reference/pancake/grid/agent/77')
    expect(described.statusCode).toBe(200)
    expect(described.json().category).toBe('grid_trading')
    const answered = await app.inject(
      '/v1/reference/pancake/grid/agent/77?pool=0x0000000000000000000000000000000000000001&tickLower=-100&tickUpper=100&spacing=10',
    )
    expect(answered.json().assessment.state).toBe('IN_GRID')
  })

  it('publishes no identity until one is configured', async () => {
    const app = server()
    expect((await app.inject('/v1/reference/pancake/grid/manifest.json')).statusCode).toBe(503)
    expect((await app.inject('/v1/reference/pancake/grid/agent/77')).statusCode).toBe(404)
    // The unregistered query route stays callable; it just claims no identity.
    expect((await app.inject('/v1/reference/pancake/grid')).statusCode).toBe(200)
  })
})
