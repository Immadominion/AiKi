import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { ApiError, api } from '../../lib/api'
import { invalidateWalletSession } from '../../lib/wallet-session'
import { actionResultMessage, OnChainRecord } from './OnChainRecord'

const originalJob = api.job
const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  api.job = originalJob
})
after(() => {
  if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})
const policy = { allow: true, rule: 'ok', reason: 'allowed' }
const rendered = () => JSON.stringify(renderer?.toJSON())
const button = (label: string) =>
  renderer?.root.findAllByType('button').find((node) => node.children.includes(label))
const pendingJob: Awaited<ReturnType<typeof api.job>> = {
  id: 'job',
  status: 'RUNNING',
  events: [],
  execution: { state: 'UNCONFIRMED', chainId: 56, transactionHash: `0x${'ab'.repeat(32)}` },
}

test('a transaction without confirmation is never presented as a refusal or a successful payment', () => {
  for (const allow of [true, false]) {
    const message = actionResultMessage({
      policy: { ...policy, allow },
      heldBy: 'chain',
      chain: { status: 'unconfirmed' },
    })
    assert.match(message, /pending/)
    assert.match(message, /held/)
    assert.doesNotMatch(message, /Nothing moved|landed|Refused/)
  }
  assert.match(actionResultMessage({ policy, heldBy: 'aiki' }), /No on-chain transaction/)
  const live = actionResultMessage({
    policy: { ...policy, allow: false, rule: 'execution_pending' },
    heldBy: 'chain',
    chain: { status: 'unconfirmed' },
  })
  assert.match(live, /already in progress/)
  assert.doesNotMatch(live, /Refused|needs review|held/)
})

test('a persisted unresolved execution remains visible after reload and disables another action', async () => {
  const hash = `0x${'ab'.repeat(32)}`
  api.job = async () => ({
    id: 'job',
    status: 'RUNNING',
    events: [],
    execution: { state: 'UNCONFIRMED', chainId: 56, transactionHash: hash },
  })
  await act(async () => {
    renderer = create(createElement(OnChainRecord, { jobId: 'job' }))
  })
  const text = JSON.stringify(renderer?.toJSON())
  assert.match(text, /Execution needs review/)
  assert.ok(text.includes(hash))
  assert.equal(renderer?.root.findAllByType('button')[0]?.props.disabled, true)
})

test('failed refreshes retain the unresolved hash and block another action until a verified update', async () => {
  api.job = async () => pendingJob
  await act(async () => {
    renderer = create(createElement(OnChainRecord, { jobId: 'job' }))
  })
  api.job = async () => {
    throw new ApiError(503, 'UNAVAILABLE', 'Unavailable.', true)
  }
  await act(async () => button('Refresh status')?.props.onClick())
  // The click starts an async load. Flush its rejected promise and state update.
  await act(async () => {})
  assert.match(rendered(), /Execution needs review/)
  assert.ok(rendered().includes(pendingJob.execution?.transactionHash ?? 'missing'))
  assert.match(rendered(), /Last known status is shown/)
  assert.equal(button('Try an over-limit action')?.props.disabled, true)
  assert.ok(button('Try again'))
  api.job = async () => ({ id: 'job', status: 'RUNNING', events: [] })
  await act(async () => button('Try again')?.props.onClick())
  await act(async () => {})
  assert.doesNotMatch(rendered(), /Execution needs review|could not be refreshed/)
  assert.equal(button('Try an over-limit action')?.props.disabled, false)
})

test('an initial request failure is visible and never enables an unverified action', async () => {
  api.job = async () => {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in.', false)
  }
  await act(async () => {
    renderer = create(createElement(OnChainRecord, { jobId: 'job' }))
  })
  assert.match(rendered(), /could not be refreshed/)
  assert.equal(button('Try an over-limit action')?.props.disabled, true)
  assert.ok(button('Try again'))
})

test('preparing and submitted transactions are in progress, not a terminal stopped watch', async () => {
  for (const state of ['PREPARING', 'SUBMITTED'] as const) {
    api.job = async () => ({
      ...pendingJob,
      execution: { ...pendingJob.execution, chainId: 56, state },
    })
    await act(async () => {
      renderer = create(createElement(OnChainRecord, { jobId: 'job' }))
    })
    assert.match(rendered(), /Execution in progress/)
    assert.doesNotMatch(rendered(), /needs review|actions are stopped/)
    assert.equal(button('Try an over-limit action')?.props.disabled, true)
    await act(async () => renderer?.unmount())
  }
})

test('a late previous-job response never replaces the current unresolved execution', async () => {
  let resolveOld: (job: typeof pendingJob) => void = () => {}
  api.job = async (id) =>
    id === 'old'
      ? new Promise((resolve) => {
          resolveOld = resolve
        })
      : pendingJob
  await act(async () => {
    renderer = create(createElement(OnChainRecord, { jobId: 'old' }))
  })
  await act(async () => renderer?.update(createElement(OnChainRecord, { jobId: 'job' })))
  await act(async () => resolveOld({ id: 'old', status: 'RUNNING', events: [] }))
  assert.match(rendered(), /Execution needs review/)
  assert.equal(button('Try an over-limit action')?.props.disabled, true)
})

test('changing wallets clears private execution details and discards the previous wallet response', async () => {
  let resolveOld: (job: typeof pendingJob) => void = () => {}
  let calls = 0
  api.job = async () => {
    if (++calls === 1)
      return new Promise((resolve) => {
        resolveOld = resolve
      })
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in.', false)
  }
  await act(async () => {
    renderer = create(createElement(OnChainRecord, { jobId: 'job' }))
  })
  await act(async () => {
    invalidateWalletSession()
  })
  await act(async () => resolveOld(pendingJob))
  assert.doesNotMatch(rendered(), /Execution needs review/)
  assert.ok(!rendered().includes(pendingJob.execution?.transactionHash ?? 'missing'))
  assert.equal(button('Try an over-limit action')?.props.disabled, true)
})
