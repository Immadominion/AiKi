import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import { createSiweMessage } from 'viem/siwe'
import { afterEach, expect, it } from 'vitest'
import { InMemoryEvidenceStore } from '../evidence/store.js'
import { createApiServer } from '../http/server.js'
import { InMemoryNonceStore } from './nonce-store.js'
import { SessionSigner } from './session.js'

const SECRET = 'test-secret-that-is-long-enough-to-pass'
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)

const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function server() {
  const app = createApiServer({
    observations: () => new InMemoryEvidenceStore().observations,
    auth: {
      signer: new SessionSigner(SECRET),
      nonces: new InMemoryNonceStore(),
      domain: 'aiki.test',
      secureCookies: false,
      // Never reached for an EOA: the signature recovers to an address without
      // any network call. It exists for the ERC-1271 smart-account path.
      client: createPublicClient({ chain: bsc, transport: http('http://127.0.0.1:1') }),
    },
  })
  apps.push(app)
  return app
}

async function signIn(app: ReturnType<typeof createApiServer>, domain = 'aiki.test') {
  const { nonce } = (await app.inject({ method: 'POST', url: '/v1/auth/nonce' })).json()
  const message = createSiweMessage({
    domain,
    address: account.address,
    statement: 'Sign in to AiKi.',
    uri: `https://${domain}`,
    version: '1',
    chainId: 56,
    nonce,
  })
  const signature = await account.signMessage({ message })
  return { message, signature, nonce }
}

it('accepts a correctly signed message and issues a session', async () => {
  const app = server()
  const { message, signature } = await signIn(app)
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { message, signature },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().address).toBe(account.address.toLowerCase())

  const cookie = response.headers['set-cookie'] as string
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')

  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })
  expect(me.json().address).toBe(account.address.toLowerCase())
})

it('burns the nonce, so a captured signature cannot be replayed', async () => {
  const app = server()
  const { message, signature } = await signIn(app)
  const first = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { message, signature },
  })
  expect(first.statusCode).toBe(200)

  const replay = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { message, signature },
  })
  expect(replay.statusCode).toBe(401)
  expect(replay.json().error.code).toBe('SIWE_NONCE_INVALID')
})

it('rejects a signature for another domain', async () => {
  const app = server()
  // A real signature, from the real key, for a different site.
  const { message, signature } = await signIn(app, 'evil.test')
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { message, signature },
  })
  expect(response.statusCode).toBe(401)
  expect(response.json().error.code).toBe('SIWE_SIGNATURE_INVALID')
})

it('rejects a message signed by a different key', async () => {
  const app = server()
  const { message } = await signIn(app)
  const impostor = privateKeyToAccount(`0x${'22'.repeat(32)}`)
  const signature = await impostor.signMessage({ message })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { message, signature },
  })
  expect(response.statusCode).toBe(401)
})

it('rejects a forged session cookie', async () => {
  const app = server()
  const forged = new SessionSigner('a-different-secret-that-is-long-enough').issue(
    account.address,
    56,
  )
  const me = await app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { cookie: `aiki_session=${forged}` },
  })
  expect(me.statusCode).toBe(401)
})

it('refuses to touch another address mandate', async () => {
  const app = server()
  const { message, signature } = await signIn(app)
  const cookie = (
    await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { message, signature } })
  ).headers['set-cookie'] as string

  const authorization = await app.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: { cookie },
    payload: {
      constraints: [{ kind: 'session_total_cap', label: 'cap', value: '10', tier: 'T2' }],
    },
  })
  expect(authorization.statusCode).toBe(200)
  const id = authorization.json().id

  // An unauthenticated caller gets nothing.
  expect(
    (await app.inject({ method: 'POST', url: `/v1/authorizations/${id}/revoke` })).statusCode,
  ).toBe(401)

  // A different, validly-signed-in address is told it does not exist, rather
  // than that it exists and is someone else's.
  const stranger = new SessionSigner(SECRET).issue(`0x${'99'.repeat(20)}`, 56)
  const denied = await app.inject({
    method: 'POST',
    url: `/v1/authorizations/${id}/revoke`,
    headers: { cookie: `aiki_session=${stranger}` },
  })
  expect(denied.statusCode).toBe(404)
})
