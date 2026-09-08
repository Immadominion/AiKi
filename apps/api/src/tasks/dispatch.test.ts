import { expect, it, vi } from 'vitest'

/*
 * The guard is mocked, not the global fetch, because the guard resolves DNS and
 * refuses private addresses before any request is made. That check is real and
 * is tested where it lives; what is under test here is how an answer from a
 * stranger's server is read.
 */
const fetched = vi.fn()
vi.mock('../net/guard.js', () => ({ guardedFetch: (...args: unknown[]) => fetched(...args) }))

const { DISPATCH_PROTOCOL, deliveryToken, dispatchToAgent, tokenMatches } = await import(
  './dispatch.js'
)

/*
 * What comes back from a third-party endpoint, read generously but not
 * credulously.
 *
 * This matters more here than it would elsewhere, because of what the registry
 * actually contains: 2,611 of the agents probed on BSC are static pages, and a
 * static page answers a POST with a 200 and some HTML. Treating that as
 * delivered work would have the marketplace paying for a marketing site.
 */

const answer = (body: unknown, status = 200) => {
  fetched.mockReset()
  fetched.mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

const envelope = {
  protocol: DISPATCH_PROTOCOL,
  taskId: 'task-1',
  agentId: '315943',
  title: 'Price a position',
  brief: 'Say what it is worth.',
  pricePoints: 900,
  deadline: '2026-09-03T00:00:00.000Z',
  callback: { url: 'https://aiki.example/v1/tasks/task-1/deliver', token: 'tok' },
} as const

const send = () => dispatchToAgent({ endpoint: 'https://agent.example/work', envelope })

it('takes work an agent hands back straight away', async () => {
  answer({ result: 'It is worth 12 USDT, because the pool holds…' })
  const out = await send()
  expect(out.delivered).toMatch(/12 USDT/)
})

it('does not pay for a web page', async () => {
  // The common case in this registry, and the expensive one to get wrong.
  answer('<!doctype html><h1>My agent</h1>')
  const out = await send()
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/not JSON/)
})

it('does not pay for JSON that contains no work', async () => {
  answer({ ok: true, message: 'hello' })
  const out = await send()
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/nothing this protocol recognises/)
})

it('understands an agent that will call back', async () => {
  answer({ accepted: true })
  expect((await send()).delivered).toBeUndefined()
  answer('', 202)
  const later = await send()
  expect(later.delivered).toBeUndefined()
  expect(later.note).toMatch(/call back/)
})

it('records a refusal in the agent own words', async () => {
  answer({ error: 'I do not do that kind of work.' })
  const out = await send()
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/I do not do that kind of work/)
})

it('records an unreachable endpoint rather than throwing', async () => {
  // Being unreachable is a fact about that agent, and this product exists to
  // record such facts. It is not an error in the hire that discovered it.
  fetched.mockReset()
  fetched.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
  const out = await send()
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/Could not reach it/)
})

it('gives every task its own delivery token, and checks it exactly', async () => {
  const secret = 'a-signing-secret-long-enough-to-use'
  const mine = deliveryToken(secret, 'task-1')
  expect(deliveryToken(secret, 'task-2')).not.toBe(mine)
  expect(tokenMatches(secret, 'task-1', mine)).toBe(true)
  // Another task's token must not open this one, which is the whole reason the
  // token is derived from the task rather than being one shared secret.
  expect(tokenMatches(secret, 'task-1', deliveryToken(secret, 'task-2'))).toBe(false)
  expect(tokenMatches(secret, 'task-1', '')).toBe(false)
  expect(tokenMatches(secret, 'task-1', `${mine}x`)).toBe(false)
})
