import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { api } from './api'
import { acceptWalletSession, invalidateWalletSession, walletSession } from './wallet-session'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateWalletSession()
})

test('account creation sends explicit JSON null and retains the authenticated wallet binding', async () => {
  const owner = `0x${'11'.repeat(20)}`,
    address = `0x${'22'.repeat(20)}`
  acceptWalletSession(owner, walletSession().revision)
  const calls: { url: string; request: RequestInit }[] = []
  globalThis.fetch = async (url, request) => {
    calls.push({ url: String(url), request: request ?? {} })
    return Response.json({ address, chainId: 56, created: false })
  }
  assert.deepEqual(await api.createAccount(), { address, chainId: 56, created: false })
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.ok(call)
  assert.ok(call.url.endsWith('/v1/account'))
  assert.equal(call.request.method, 'POST')
  assert.equal(call.request.body, 'null')
  assert.equal(new Headers(call.request.headers).get('content-type'), 'application/json')
  assert.equal(new Headers(call.request.headers).get('x-aiki-wallet-address'), owner)
  assert.equal(call.request.credentials, 'include')
  assert.equal(call.request.cache, 'no-store')
})
