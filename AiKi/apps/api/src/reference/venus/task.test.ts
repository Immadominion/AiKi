import { expect, it, vi } from 'vitest'
import { createVenusReferenceServer } from './server.js'
import type { VenusHealthAssessment } from './types.js'

/*
 * The first implementation of the envelope AiKi's marketplace sends.
 *
 * A protocol with no implementers is a document, and hiring this agent used to
 * produce a 404, which was honest and useless. What matters most here is the
 * decline: this agent reads Venus positions, and being paid for a confident
 * answer to a question it cannot answer is worse for the buyer than being told
 * no. A decline refunds; a wrong answer does not.
 */

const AGENT_ID = '315943'
const ACCOUNT = '0x1111111111111111111111111111111111111111'

const assessment = {
  account: ACCOUNT,
  protocol: 'Venus',
  category: 'health_factor',
  assessmentVersion: 'venus-health/v1',
  observedAt: '2026-09-02T00:00:00.000Z',
  status: 'healthy',
  minimumHealthFactor: '1.25',
  healthFactor: '1.84',
  supplied: { amount: '5000000000000000000000', asset: 'USD', decimals: 18 },
  adjustedCollateral: { amount: '4000000000000000000000', asset: 'USD', decimals: 18 },
  borrowed: { amount: '2173913043478260869565', asset: 'USD', decimals: 18 },
  controllerLiquidity: { amount: '0', asset: 'USD', decimals: 18 },
  controllerShortfall: { amount: '0', asset: 'USD', decimals: 18 },
  positions: [],
  methodology: 'reading the Venus comptroller directly',
  consistency: { verified: true, detail: 'agrees' },
} as unknown as VenusHealthAssessment

const serve = (assess = vi.fn().mockResolvedValue(assessment)) => {
  const app = createVenusReferenceServer({
    reader: { assess } as never,
    registration: { agentId: AGENT_ID } as never,
  })
  return { app, assess }
}

const hire = (app: ReturnType<typeof serve>['app'], brief: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/reference/venus/agent/${AGENT_ID}`,
    payload: { protocol: 'aiki.task/v1', taskId: 't1', brief },
  })

it('does the work when the brief names an account', async () => {
  const { app } = serve()
  const res = await hire(app, `Check the health factor on ${ACCOUNT} before it gets liquidated.`)

  const body = res.json() as { result?: string }
  expect(body.result).toContain('1.84')
  // The methodology travels with the number. An unexplained health factor is a
  // claim, and this product does not sell claims.
  expect(body.result).toContain('reading the Venus comptroller directly')
  expect(body.result).toContain(ACCOUNT)
})

it('declines work it cannot do rather than answering badly', async () => {
  const { app, assess } = serve()
  const res = await hire(app, 'Write me a blog post about lending markets.')

  const body = res.json() as { error?: string; result?: string }
  expect(body.result).toBeUndefined()
  expect(body.error).toMatch(/Venus positions/)
  // And it did not go and read anything, because there was nothing to read.
  expect(assess).not.toHaveBeenCalled()
})

it('says so when the chain will not answer, instead of inventing a number', async () => {
  const { app } = serve(vi.fn().mockRejectedValue(new Error('RPC timed out')))
  const res = await hire(app, `Assess ${ACCOUNT}`)

  const body = res.json() as { error?: string; result?: string }
  expect(body.result).toBeUndefined()
  expect(body.error).toMatch(/RPC timed out/)
})

it('refuses an envelope it does not speak', async () => {
  const { app } = serve()
  const res = await app.inject({
    method: 'POST',
    url: `/v1/reference/venus/agent/${AGENT_ID}`,
    payload: { brief: 'do something' },
  })
  expect(res.statusCode).toBe(400)
})

it('serves only the identity it was configured with', async () => {
  // Somebody else's agent id must not be answerable here, or one endpoint could
  // take work on behalf of an identity it does not hold.
  const { app } = serve()
  const res = await app.inject({
    method: 'POST',
    url: '/v1/reference/venus/agent/999999',
    payload: { protocol: 'aiki.task/v1', brief: `Assess ${ACCOUNT}` },
  })
  expect(res.statusCode).toBe(404)
})
