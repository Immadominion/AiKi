import { expect, it, vi } from 'vitest'
import { AikiClient, AikiError } from './client.js'

/**
 * The two things this client does that a bare fetch does not: it keeps a
 * session, and it turns a refusal back into the sentence the API wrote. Both
 * matter more here than usual — the caller is a language model deciding what to
 * do next, and "409" tells it nothing.
 */

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? '' : JSON.stringify(body), { status, headers })

it('keeps the session cookie the API issues and sends it back', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValueOnce(
    respond(200, { address: '0xabc' }, { 'set-cookie': 'aiki_session=abc123; Path=/; HttpOnly' }),
  )
  const client = new AikiClient('https://api.test')
  expect(client.signedIn).toBe(false)
  await client.post('/v1/auth/verify', {})
  expect(client.signedIn).toBe(true)

  fetchMock.mockResolvedValueOnce(respond(200, { ok: true }))
  await client.get('/v1/account')
  const headers = fetchMock.mock.calls[1]?.[1].headers as Record<string, string>
  // Only the name=value pair, not the attributes: sending Path and HttpOnly
  // back as part of the cookie is how a session silently stops being sent.
  expect(headers.cookie).toBe('aiki_session=abc123')
  vi.unstubAllGlobals()
})

it('raises the API’s own sentence, not its status code', async () => {
  // A fresh Response each call: a body can only be read once, and reusing one
  // makes the second assertion fail on the plumbing rather than the behaviour.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      respond(409, {
        error: {
          code: 'WATCH_UNSIGNED',
          message:
            'This mandate has not been signed, so nothing on chain would limit an agent acting on its own.',
        },
      }),
    ),
  )
  const client = new AikiClient('https://api.test')
  await expect(client.post('/v1/jobs/1/watch', {})).rejects.toThrow(/has not been signed/)
  await expect(client.post('/v1/jobs/1/watch', {})).rejects.toMatchObject({
    code: 'WATCH_UNSIGNED',
    status: 409,
  })
  vi.unstubAllGlobals()
})

it('survives a refusal that carries no body at all', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => respond(502, null)),
  )
  const client = new AikiClient('https://api.test')
  await expect(client.get('/v1/stats')).rejects.toBeInstanceOf(AikiError)
  await expect(client.get('/v1/stats')).rejects.toThrow(/502/)
  vi.unstubAllGlobals()
})

it('does not send a content-type on a request with no body', async () => {
  // Fastify refuses an empty body when the content type says JSON, which is how
  // revoke answered 500 from the browser and 200 from curl.
  const fetchMock = vi.fn().mockResolvedValue(respond(200, { ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  await new AikiClient('https://api.test').post('/v1/authorizations/1/revoke')
  const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
  expect(headers['content-type']).toBeUndefined()
  vi.unstubAllGlobals()
})
