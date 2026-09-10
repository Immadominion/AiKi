import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerStrategyRoutes, type StrategyRoutesService } from './routes.js'

const owner = `0x${'11'.repeat(20)}`,
  other = `0x${'22'.repeat(20)}`
const id = '11111111-1111-4111-8111-111111111111',
  actionId = '22222222-2222-4222-8222-222222222222'
const base = `/v1/strategies/${id}`
const closed: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => {
  await Promise.all(closed.splice(0).map((app) => app.close()))
})
function fixture(auth = true) {
  const app = Fastify()
  closed.push(app)
  if (auth)
    app.addHook('onRequest', async (request) => {
      request.session = { address: owner, chainId: 56, exp: Math.floor(Date.now() / 1000) + 60 }
    })
  const service = {
    publicConfig: vi.fn(async () => ({
      available: false,
      chainId: 56,
      reason: 'Reviewed factories unavailable.',
    })),
    list: vi.fn(async () => ({ setups: [] })),
    prepare: vi.fn(async () => ({ id })),
    get: vi.fn(async () => ({ id })),
    prepareAction: vi.fn(async () => ({ id })),
    submitAction: vi.fn(async () => ({ id })),
    finalizeAction: vi.fn(async () => ({ id })),
    prepareAuthorization: vi.fn(async () => ({ setupId: id })),
    fileAuthorization: vi.fn(async () => ({ id })),
    start: vi.fn(async () => ({ id })),
    pause: vi.fn(async () => ({ id })),
    recover: vi.fn(async () => ({ id })),
  }
  registerStrategyRoutes(app, service as unknown as StrategyRoutesService)
  return { app, service }
}
const protectedRoutes = [
  ['GET', '/v1/strategies'],
  ['GET', base],
  ['POST', '/v1/strategies/prepare'],
  ['POST', `${base}/actions/prepare`],
  ['POST', `${base}/actions/${actionId}/submit`],
  ['POST', `${base}/actions/${actionId}/finalize`],
  ['POST', `${base}/authorization/prepare`],
  ['POST', `${base}/authorization`],
  ['POST', `${base}/start`],
  ['POST', `${base}/pause`],
  ['POST', `${base}/recover`],
] as const
describe('owner-scoped strategy routes', () => {
  it('exposes only no-store availability without authentication', async () => {
    const { app, service } = fixture(false),
      response = await app.inject({ method: 'GET', url: '/v1/strategies/config' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      available: false,
      chainId: 56,
      reason: 'Reviewed factories unavailable.',
    })
    expect(service.publicConfig).toHaveBeenCalledOnce()
  })
  it.each(protectedRoutes)('refuses unsigned %s %s before service access', async (method, url) => {
    const { app, service } = fixture(false),
      response = await app.inject({ method, url })
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })
  it.each(protectedRoutes)('refuses a changed wallet for %s %s', async (method, url) => {
    const { app, service } = fixture(),
      response = await app.inject({ method, url, headers: { 'X-Aiki-Wallet-Address': other } })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('WALLET_SESSION_CHANGED')
    expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })
  it.each(['/v1/strategies/prepare', `${base}/actions/prepare`])(
    'requires an intent key on %s',
    async (url) => {
      const { app, service } = fixture()
      for (const key of [undefined, 'has whitespace', 'x'.repeat(161)]) {
        const response = await app.inject({
          method: 'POST',
          url,
          payload: {},
          ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
        })
        expect(response.statusCode).toBe(400)
      }
      expect(service.prepare).not.toHaveBeenCalled()
      expect(service.prepareAction).not.toHaveBeenCalled()
    },
  )
  it('forwards authenticated owner and exact intent independently from untrusted body owner fields', async () => {
    const { app, service } = fixture(),
      body = { owner: other, input: {}, gasLimitWei: '1' }
    await app.inject({
      method: 'POST',
      url: '/v1/strategies/prepare',
      headers: { 'Idempotency-Key': 'setup-key' },
      payload: body,
    })
    expect(service.prepare).toHaveBeenCalledWith(owner, body, 'setup-key')
    await app.inject({
      method: 'POST',
      url: `${base}/actions/prepare`,
      headers: { 'Idempotency-Key': 'wallet-key' },
      payload: { kind: 'resume' },
    })
    expect(service.prepareAction).toHaveBeenCalledWith(owner, id, { kind: 'resume' }, 'wallet-key')
  })
  it.each(['start', 'pause', 'recover', 'authorization/prepare', `actions/${actionId}/finalize`])(
    'rejects authority/hash overrides on %s',
    async (suffix) => {
      const { app, service } = fixture(),
        response = await app.inject({
          method: 'POST',
          url: `${base}/${suffix}`,
          payload: { transactionHash: `0x${'ab'.repeat(32)}`, delegate: other },
        })
      expect(response.statusCode).toBe(400)
      expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
    },
  )
  it('uses persisted target only for recovery and finalization, never a body transaction', async () => {
    const { app, service } = fixture()
    expect(
      (await app.inject({ method: 'POST', url: `${base}/actions/${actionId}/finalize` }))
        .statusCode,
    ).toBe(200)
    expect(service.finalizeAction).toHaveBeenCalledWith(owner, id, actionId)
    expect((await app.inject({ method: 'POST', url: `${base}/recover` })).statusCode).toBe(200)
    expect(service.recover).toHaveBeenCalledWith(owner, id)
  })
  it.each(['start', 'pause', 'recover', 'authorization/prepare', `actions/${actionId}/finalize`])(
    'accepts explicit JSON null for empty %s browser requests',
    async (suffix) => {
      const { app } = fixture()
      const result = await app.inject({
        method: 'POST',
        url: `${base}/${suffix}`,
        headers: { 'content-type': 'application/json' },
        payload: 'null',
      })
      expect(result.statusCode).toBe(200)
    },
  )
  it('rejects malformed identifiers and bounded oversized signing bodies', async () => {
    const { app, service } = fixture()
    expect((await app.inject({ method: 'GET', url: '/v1/strategies/not-a-uuid' })).statusCode).toBe(
      404,
    )
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/authorization`,
          payload: { signature: 'x'.repeat(2048) },
        })
      ).statusCode,
    ).toBe(413)
    expect(service.get).not.toHaveBeenCalled()
    expect(service.fileAuthorization).not.toHaveBeenCalled()
  })
})
