import { afterEach, describe, expect, it } from 'vitest'
import { createApiServer } from '../http/server.js'

const apps: ReturnType<typeof createApiServer>[] = []
function server() {
  const app = createApiServer({ observations: () => [] })
  apps.push(app)
  return app
}
const run = {
  agentId: '1',
  scenarioId: 's',
  trials: 1,
  successes: 1,
  medianLatencyMs: 1,
  costUsd: '0',
}
afterEach(async () => {
  process.env.ARENA_INGEST_TOKEN = ''
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('benchmark ingestion', () => {
  it('refuses every write when no token is configured', async () => {
    const response = await server().inject({ method: 'POST', url: '/v1/arena/runs', payload: run })
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('INGEST_DISABLED')
  })

  it('refuses a missing or wrong token, and accepts the configured one', async () => {
    process.env.ARENA_INGEST_TOKEN = 'a-real-token'
    const app = server()
    expect(
      (await app.inject({ method: 'POST', url: '/v1/arena/runs', payload: run })).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/arena/runs',
          payload: run,
          headers: { authorization: 'Bearer wrong-token' },
        })
      ).statusCode,
    ).toBe(401)
    // A prefix of the real token must not pass; the comparison is length-checked.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/arena/runs',
          payload: run,
          headers: { authorization: 'Bearer a-real' },
        })
      ).statusCode,
    ).toBe(401)
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/arena/runs',
      payload: run,
      headers: { authorization: 'Bearer a-real-token' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().agentId).toBe('1')
  })

  it('leaves the leaderboard readable without a token', async () => {
    expect((await server().inject('/v1/arena/leaderboards')).statusCode).toBe(200)
  })
})
