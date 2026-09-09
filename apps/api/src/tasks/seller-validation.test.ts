import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { ClientError } from '../http/errors.js'
import type { JobService } from '../jobs/service.js'
import { PLATFORM_FEE_BPS } from '../settlement/pricing.js'
import { registerTaskRoutes } from './routes.js'
import type { PostgresSellerStore } from './sellers.js'
import type { TaskStore } from './store.js'

const owner = `0x${'a1'.repeat(20)}`
const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
function harness(authenticated = true) {
  const app = Fastify()
  const put = vi.fn(async (input) => ({
    ...input,
    record: { delivered: 0, disputed: 0, earnedPoints: 0 },
  }))
  app.addHook('onRequest', async (request) => {
    if (authenticated) request.session = { address: owner, chainId: 97, exp: 9_999_999_999 }
  })
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof ClientError ? error.statusCode : 500)
      .send({ error: { code: error instanceof ClientError ? error.code : 'UNKNOWN' } }),
  )
  registerTaskRoutes(app, {
    tasks: {} as TaskStore,
    jobs: {} as JobService,
    sellers: { put, list: async () => [] } as unknown as PostgresSellerStore,
  })
  apps.push(app)
  const valid = {
    name: 'A writer',
    blurb: 'I write clear onboarding copy.',
    kinds: ['writing'],
    ratePoints: 500,
    available: true,
  }
  return {
    app,
    put,
    request: (changes: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/v1/sellers/me', payload: { ...valid, ...changes } }),
  }
}

it('publishes the actual task minimum and settlement fee for the offer review', async () => {
  const { app } = harness()
  expect((await app.inject({ method: 'GET', url: '/v1/sellers' })).json()).toMatchObject({
    minimumPricePoints: 10,
    feeBasisPoints: PLATFORM_FEE_BPS,
    sellers: [],
  })
})

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '500', 'NaN', null, {}, []])(
  'rejects invalid seller rates before writing: %j',
  async (ratePoints) => {
    const { request, put } = harness()
    const result = await request({ ratePoints })
    expect(result.statusCode).toBe(400)
    expect(result.json().error.code).toBe('LISTING_RATE_INVALID')
    expect(put).not.toHaveBeenCalled()
  },
)

it.each([
  { kinds: 'writing' },
  { kinds: ['unknown'] },
  { kinds: [null] },
  { available: 'false' },
  { available: 0 },
])('rejects malformed kinds and availability: %j', async (changes) => {
  const { request, put } = harness()
  expect((await request(changes)).statusCode).toBe(400)
  expect(put).not.toHaveBeenCalled()
})

it('saves paused availability without changing owner or erasing the listing', async () => {
  const { request, put } = harness()
  const result = await request({
    available: false,
    owner: `0x${'b2'.repeat(20)}`,
    kinds: ['writing', 'writing'],
    ratePoints: 0,
  })
  expect(result.statusCode).toBe(200)
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({
      address: owner,
      available: false,
      kinds: ['writing'],
      ratePoints: 0,
    }),
  )
})

it('requires a signed-in wallet to write a listing', async () => {
  const { request, put } = harness(false)
  expect((await request({})).statusCode).toBe(401)
  expect(put).not.toHaveBeenCalled()
})
