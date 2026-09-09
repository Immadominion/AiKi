import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { ApiError, api, type Watch } from '../../lib/api'
import { invalidateWalletSession } from '../../lib/wallet-session'
import { WatchPanel } from './WatchPanel'

const original = { watch: api.watch, startWatch: api.startWatch, stopWatch: api.stopWatch }
const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let renderer: ReactTestRenderer | undefined
const active: Watch = {
  jobId: 'a',
  account: `0x${'11'.repeat(20)}`,
  chainId: 56,
  protocol: 'venus',
  minimumHealthFactor: '1.25',
  asset: `0x${'22'.repeat(20)}`,
  market: `0x${'33'.repeat(20)}`,
  status: 'active',
  createdAt: '2026-09-09T12:00:00Z',
}
const rendered = () => JSON.stringify(renderer?.toJSON())
const button = (label: string) =>
  renderer?.root.findAllByType('button').find((node) => node.children.includes(label))

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  Object.assign(api, original)
})
after(() => {
  if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf)
  else Reflect.deleteProperty(globalThis, 'self')
  if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

test('a network failure is not presented as an absent watch and retry recovers', async () => {
  let failed = true
  api.watch = async () => {
    if (failed)
      throw new ApiError(503, 'UNAVAILABLE', 'Watch status is temporarily unavailable.', true)
    return active
  }
  await act(async () => {
    renderer = create(createElement(WatchPanel, { jobId: 'a' }))
  })
  assert.equal(Boolean(button('Start watching')), false)
  assert.ok(rendered().includes('Watch status is temporarily unavailable.'))
  const retry = button('Try again')
  assert.ok(retry)
  failed = false
  await act(async () => retry.props.onClick())
  assert.ok(button('Stand down'))
  assert.ok(rendered().includes('BNB Chain'))
  assert.ok(rendered().includes('No pass recorded'))
  assert.equal(rendered().includes('Any moment now'), false)
})

test('only the explicit watch-not-found response offers activation', async () => {
  api.watch = async () => {
    throw new ApiError(404, 'WATCH_NOT_FOUND', 'Not watched.', false)
  }
  await act(async () => {
    renderer = create(createElement(WatchPanel, { jobId: 'a' }))
  })
  assert.ok(button('Start watching'))
})

test('a missing job or expired session is not a watch setup screen', async () => {
  for (const error of [
    new ApiError(404, 'NOT_FOUND', 'Job not found.', false),
    new ApiError(401, 'AUTH_REQUIRED', 'Sign in again.', false),
  ]) {
    api.watch = async () => {
      throw error
    }
    await act(async () => {
      renderer = create(createElement(WatchPanel, { jobId: 'a' }))
    })
    assert.equal(Boolean(button('Start watching')), false)
    assert.ok(rendered().includes(error.message))
    await act(async () => renderer?.unmount())
  }
})

test('a late load from the previous job never changes the current job controls', async () => {
  let resolveOld: (watch: Watch) => void = () => {}
  api.watch = async (jobId) => {
    if (jobId === 'a')
      return new Promise((resolve) => {
        resolveOld = resolve
      })
    throw new ApiError(404, 'WATCH_NOT_FOUND', 'Not watched.', false)
  }
  await act(async () => {
    renderer = create(createElement(WatchPanel, { jobId: 'a' }))
  })
  await act(async () => renderer?.update(createElement(WatchPanel, { jobId: 'b' })))
  await act(async () => resolveOld(active))
  assert.ok(button('Start watching'))
  assert.equal(Boolean(button('Stand down')), false)
})

test('a stopped watch is not offered a restart the API cannot perform', async () => {
  api.watch = async () => ({ ...active, status: 'stopped', lastReason: 'Mandate expired.' })
  await act(async () => {
    renderer = create(createElement(WatchPanel, { jobId: 'a' }))
  })
  assert.equal(Boolean(button('Start watching')), false)
  assert.ok(rendered().includes('Watch stopped'))
  assert.ok(rendered().includes('Mandate expired.'))
})

test('changing wallets clears the previous wallet watch and rejects its late response', async () => {
  let resolveOld: (watch: Watch) => void = () => {}
  let calls = 0
  api.watch = async () => {
    if (++calls === 1)
      return new Promise((resolve) => {
        resolveOld = resolve
      })
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with this wallet.', false)
  }
  await act(async () => {
    renderer = create(createElement(WatchPanel, { jobId: 'a' }))
  })
  await act(async () => {
    invalidateWalletSession()
  })
  await act(async () => resolveOld(active))
  assert.equal(Boolean(button('Stand down')), false)
  assert.ok(rendered().includes('Sign in with this wallet.'))
})

test('a failed background refresh retains the active watch and its stop control', async () => {
  const originalInterval = globalThis.setInterval
  let refresh: () => void = () => {}
  globalThis.setInterval = ((callback: () => void) => {
    refresh = callback
    return originalInterval(() => {}, 60_000)
  }) as typeof globalThis.setInterval
  try {
    api.watch = async () => active
    await act(async () => {
      renderer = create(createElement(WatchPanel, { jobId: 'a' }))
    })
    api.watch = async () => {
      throw new ApiError(503, 'UNAVAILABLE', 'Could not refresh.', true)
    }
    await act(async () => refresh())
    assert.ok(rendered().includes('Last known state shown.'))
    assert.ok(button('Stand down'))
    assert.equal(Boolean(button('Start watching')), false)
    api.stopWatch = async () => ({ ...active, status: 'stopped' })
    await act(async () => button('Stand down')?.props.onClick())
    assert.ok(rendered().includes('Watch stopped'))
    assert.equal(rendered().includes('Could not refresh.'), false)
  } finally {
    globalThis.setInterval = originalInterval
  }
})
