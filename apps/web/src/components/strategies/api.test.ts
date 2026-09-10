import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  acceptWalletSession,
  invalidateWalletSession,
  walletSession,
} from '../../lib/wallet-session'
import { strategyApi } from './api'
import { owner, setupFixture } from './test-support'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateWalletSession()
})
test('bodyless strategy actions send JSON null so Fastify does not reject an empty JSON body', async () => {
  acceptWalletSession(owner, walletSession().revision)
  const seen: { path: string; init: RequestInit }[] = []
  globalThis.fetch = async (url, init) => {
    seen.push({ path: String(url), init: init ?? {} })
    return Response.json(setupFixture())
  }
  await strategyApi.finalizeAction('setup-1', 'action-1')
  await strategyApi.prepareAuthorization('setup-1')
  await strategyApi.start('setup-1')
  await strategyApi.pause('setup-1')
  await strategyApi.recover('setup-1')
  assert.equal(seen.length, 5)
  for (const { init } of seen) {
    assert.equal(init.method, 'POST')
    assert.equal(init.body, 'null')
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json')
    assert.equal(new Headers(init.headers).get('x-aiki-wallet-address'), owner)
    assert.equal(init.cache, 'no-store')
  }
})
test('funding retry key is sent with exact raw-unit request and path-scoped identifiers', async () => {
  let seen: RequestInit | undefined,
    path = ''
  globalThis.fetch = async (url, init) => {
    seen = init
    path = String(url)
    return Response.json(setupFixture())
  }
  await strategyApi.prepareAction(
    'setup/a',
    { kind: 'fund', assets: '1000000000000000001' },
    'retained-uuid',
  )
  assert.ok(path.endsWith('/v1/strategies/setup%2Fa/actions/prepare'))
  assert.equal(new Headers(seen?.headers).get('Idempotency-Key'), 'retained-uuid')
  assert.deepEqual(JSON.parse(String(seen?.body)), { kind: 'fund', assets: '1000000000000000001' })
})
