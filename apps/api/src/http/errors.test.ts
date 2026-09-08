import { afterEach, describe, expect, it } from 'vitest'
import { createApiServer } from './server.js'

const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('error disclosure', () => {
  it('returns a deliberate message, and never an internal one', async () => {
    const app = createApiServer({ observations: () => [] })
    apps.push(app)

    // Written for a caller: parseIntent raises ClientError on empty text.
    const client = await app.inject({ method: 'POST', url: '/v1/intent', payload: { text: '' } })
    expect(client.statusCode).toBe(400)
    expect(client.json().error.message).toBe('Intent text is required.')

    // Written for us: the store blowing up must not narrate itself to a stranger.
    const leaky = createApiServer({
      observations: () => {
        throw new Error('connect ECONNREFUSED 10.0.0.7:5432 as user aiki_prod')
      },
    })
    apps.push(leaky)
    const internal = await leaky.inject('/v1/stats')
    expect(internal.statusCode).toBe(500)
    expect(internal.json().error.code).toBe('INTERNAL')
    expect(internal.body).not.toContain('ECONNREFUSED')
    expect(internal.body).not.toContain('10.0.0.7')
    expect(internal.json().error.requestId).toBeTruthy()

    const health = await leaky.inject('/healthz')
    expect(health.statusCode).toBe(503)
    expect(health.body).not.toContain('ECONNREFUSED')
  })
})
