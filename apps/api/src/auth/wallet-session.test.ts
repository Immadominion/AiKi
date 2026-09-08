import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { requireSession } from './guard.js'
import { SessionSigner } from './session.js'

const signer = new SessionSigner('wallet-session-tests-only-not-a-production-secret')
const owner = `0x${'ab'.repeat(20)}`
const other = `0x${'cd'.repeat(20)}`
const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function server(authenticated = true) {
  const app = Fastify()
  app.addHook('onRequest', async (request) => {
    if (authenticated) request.session = signer.verify(signer.issue(owner, 56)) ?? undefined
  })
  let mutations = 0
  app.post('/private-action', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    ++mutations
    return { address: session.address }
  })
  apps.push(app)
  return { app, mutations: () => mutations }
}

describe('wallet selected in this tab versus the shared session cookie', () => {
  it('refuses a different wallet before performing a private action', async () => {
    const { app, mutations } = server()
    const result = await app.inject({
      method: 'POST',
      url: '/private-action',
      headers: { 'x-aiki-wallet-address': other },
    })
    expect(result.statusCode).toBe(401)
    expect(result.json().error.code).toBe('WALLET_SESSION_CHANGED')
    expect(mutations()).toBe(0)
  })

  it('accepts a matching wallet without case-sensitive address mistakes', async () => {
    const { app, mutations } = server()
    const result = await app.inject({
      method: 'POST',
      url: '/private-action',
      headers: { 'x-aiki-wallet-address': owner.toUpperCase() },
    })
    expect(result.statusCode).toBe(200)
    expect(mutations()).toBe(1)
  })

  it('retains session-only API clients but never authenticates from the header', async () => {
    const authenticated = server()
    expect(
      (await authenticated.app.inject({ method: 'POST', url: '/private-action' })).statusCode,
    ).toBe(200)
    const unsigned = server(false)
    const result = await unsigned.app.inject({
      method: 'POST',
      url: '/private-action',
      headers: { 'x-aiki-wallet-address': owner },
    })
    expect(result.statusCode).toBe(401)
    expect(unsigned.mutations()).toBe(0)
  })
})
