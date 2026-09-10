import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { api } from './api'
import { withPublicReadDeadline } from './public-read-deadline'
import { acceptWalletSession, invalidateWalletSession, walletSession } from './wallet-session'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateWalletSession()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let n = 0; n < 12; n++) await Promise.resolve()
}

for (const [name, read] of [
  ['stats', () => api.stats()],
  ['search', () => api.search({ query: 'yield', limit: 6 })],
] as const) {
  test(`${name} rejects at 10 seconds and aborts an abort-ignoring fetch`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const transport = deferred<Response>()
    let request: RequestInit | undefined
    let failure: unknown
    const observedFailure = () => failure
    globalThis.fetch = async (_url, init) => {
      request = init
      return transport.promise
    }
    const outcome = read().catch((error: unknown) => {
      failure = error
    })
    t.mock.timers.tick(9_999)
    await flush()
    assert.equal(observedFailure(), undefined)
    assert.equal(request?.signal?.aborted, false)
    t.mock.timers.tick(1)
    await flush()
    assert.ok(failure instanceof Error)
    assert.match(failure.message, /timed out/i)
    assert.equal(request?.signal?.aborted, true)
    await outcome
    transport.resolve(Response.json({ ignored: true }))
    await flush()
  })
}

test('deadline also bounds a response body that never finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const body = deferred<unknown>()
  let signal: AbortSignal | null | undefined
  let failure: unknown
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal
    return { ok: true, json: () => body.promise } as Response
  }
  const outcome = api.stats().catch((error: unknown) => {
    failure = error
  })
  await flush()
  t.mock.timers.tick(10_000)
  await flush()
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /timed out/i)
  assert.equal(signal?.aborted, true)
  await outcome
  body.resolve({ ignored: true })
  await flush()
})

test('timeout stays a timeout when the actual fetch honors cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let aborted = false
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(new DOMException('Transport cancelled', 'AbortError'))
        },
        { once: true },
      )
    })
  const outcome = assert.rejects(api.stats(), { name: 'TimeoutError' })
  t.mock.timers.tick(10_000)
  await outcome
  assert.equal(aborted, true)
})

for (const fails of [false, true]) {
  test(`a ${fails ? 'failed' : 'successful'} read clears its deadline without aborting later`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const clear = t.mock.method(globalThis, 'clearTimeout')
    const transportError = new Error('Temporary evidence outage')
    let signal: AbortSignal | null | undefined
    globalThis.fetch = async (_url, init) => {
      signal = init?.signal
      if (fails) throw transportError
      return Response.json({ probed: { agentsProbed: 9 } })
    }
    if (fails) await assert.rejects(api.stats(), (error) => error === transportError)
    else assert.deepEqual(await api.stats(), { probed: { agentsProbed: 9 } })
    assert.equal(clear.mock.callCount(), 1)
    t.mock.timers.tick(20_000)
    assert.equal(signal?.aborted, false)
  })
}

test('a late unauthorized response cannot invalidate the current wallet session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = `0x${'11'.repeat(20)}`
  acceptWalletSession(owner, walletSession().revision)
  const initial = walletSession()
  const transport = deferred<Response>()
  globalThis.fetch = async () => transport.promise
  const outcome = assert.rejects(api.stats(), { name: 'TimeoutError' })
  t.mock.timers.tick(10_000)
  await outcome
  transport.resolve(Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }))
  await flush()
  assert.equal(walletSession().revision, initial.revision)
  assert.equal(walletSession().address, owner)
})

test('a late transport rejection is handled and cannot replace the timeout outcome', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = deferred<Response>()
  const unhandled: unknown[] = []
  const record = (error: unknown) => unhandled.push(error)
  process.on('unhandledRejection', record)
  try {
    globalThis.fetch = async () => transport.promise
    const outcome = assert.rejects(api.stats(), { name: 'TimeoutError' })
    t.mock.timers.tick(10_000)
    await outcome
    transport.reject(new Error('Late transport failure'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', record)
  }
})

test('public reads retain wallet headers, cookie rules and the wallet abort binding', async () => {
  const owner = `0x${'22'.repeat(20)}`
  acceptWalletSession(owner, walletSession().revision)
  const transport = deferred<Response>()
  let request: RequestInit | undefined
  globalThis.fetch = async (_url, init) => {
    request = init
    return transport.promise
  }
  const outcome = assert.rejects(api.search({ query: 'grid' }), { code: 'WALLET_CHANGED' })
  assert.equal(new Headers(request?.headers).get('x-aiki-wallet-address'), owner)
  assert.equal(request?.credentials, 'include')
  assert.equal(request?.cache, 'no-store')
  assert.equal(request?.body, JSON.stringify({ query: 'grid' }))
  invalidateWalletSession()
  assert.equal(request?.signal?.aborted, true)
  transport.resolve(Response.json({ results: [] }))
  await outcome
})

test('an unsigned public read still omits wallet credentials', async () => {
  invalidateWalletSession()
  let request: RequestInit | undefined
  globalThis.fetch = async (_url, init) => {
    request = init
    return Response.json({})
  }
  await api.stats()
  assert.equal(request?.credentials, 'omit')
  assert.equal(new Headers(request?.headers).has('x-aiki-wallet-address'), false)
})

test('financial mutations do not opt into the public-read deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = deferred<Response>()
  let request: RequestInit | undefined
  let settled = false
  globalThis.fetch = async (_url, init) => {
    request = init
    return transport.promise
  }
  const outcome = api.createAccount().then((result) => {
    settled = true
    return result
  })
  t.mock.timers.tick(30_000)
  await flush()
  assert.equal(settled, false)
  assert.equal(request?.signal?.aborted, false)
  transport.resolve(Response.json({ address: `0x${'33'.repeat(20)}`, chainId: 56, created: false }))
  assert.equal((await outcome).created, false)
})

test('a synchronous reader failure also clears its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clear = t.mock.method(globalThis, 'clearTimeout')
  const error = new Error('Cannot start public read')
  await assert.rejects(
    withPublicReadDeadline(() => {
      throw error
    }),
    (reason) => reason === error,
  )
  assert.equal(clear.mock.callCount(), 1)
  t.mock.timers.tick(10_000)
})
