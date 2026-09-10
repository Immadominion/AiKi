// biome-ignore-all lint/style/noNonNullAssertion: fixture has exactly one wallet action whose receipt state is varied.
import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, test } from 'node:test'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { api } from '../../lib/api'
import { selectWallet } from '../../lib/wallet'
import {
  acceptWalletSession,
  invalidateWalletSession,
  walletSession,
} from '../../lib/wallet-session'
import { strategyApi } from './api'
import { ConnectedStrategySetup } from './StrategySetup'
import {
  config,
  controller,
  filledValues,
  memoryStorage,
  owner,
  setupFixture,
} from './test-support'

const originalApi = { ...strategyApi },
  account = api.account
const globals = new Map(
  ['window', 'self', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
)
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  prefetch() {},
  push() {},
  replace() {},
  bfcacheId: 'strategy-test',
}
let renderer: ReactTestRenderer | undefined
const text = () => JSON.stringify(renderer?.toJSON())
const button = (label: string) =>
  renderer?.root.findAllByType('button').find((node) => node.children.includes(label))
async function mount(id?: string) {
  await act(async () => {
    renderer = create(
      createElement(
        AppRouterContext.Provider,
        { value: router },
        createElement(ConnectedStrategySetup, { kind: 'yield', owner, initialSetupId: id }),
      ),
    )
  })
}
beforeEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: memoryStorage(),
    configurable: true,
  })
  invalidateWalletSession()
  acceptWalletSession(owner, walletSession().revision)
  selectWallet({
    uuid: 'strategy-mounted',
    name: 'Mock only',
    rdns: 'test',
    icon: '',
    provider: {
      request: async ({ method }) => {
        if (method === 'eth_accounts') return [owner]
        if (method === 'eth_chainId') return '0x38'
        throw new Error('No wallet prompts permitted in mounted test')
      },
    },
  })
  strategyApi.config = async () => structuredClone(config)
  strategyApi.list = async () => ({ setups: [] })
  api.account = async () => ({ address: controller, chainId: 56, network: 'mainnet' })
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  Object.assign(strategyApi, originalApi)
  api.account = account
  invalidateWalletSession()
})
after(() => {
  for (const [key, value] of globals)
    if (value) Object.defineProperty(globalThis, key, value)
    else Reflect.deleteProperty(globalThis, key)
})

test('missing deployments visibly block policy preparation and never show ready wallet transactions', async () => {
  strategyApi.config = async () => ({
    available: false,
    chainId: 56,
    reason: 'Reviewed factories are not deployed.',
  })
  await mount()
  assert.match(text(), /Automation setup is not ready/)
  assert.match(text(), /Do not send funds/)
  assert.equal(button('Confirm this transaction in wallet'), undefined)
  assert.ok(button('Review deployment and policy')?.props.disabled)
})
test('failed setup preparation preserves exact inputs and UUID/expiry across explicit retries', async () => {
  const calls: Parameters<typeof strategyApi.prepare>[] = []
  strategyApi.prepare = async (...args) => {
    calls.push(args)
    throw new Error('Preparation response unavailable')
  }
  await mount()
  for (const [key, value] of Object.entries(filledValues()))
    await act(async () => {
      renderer?.root.findByProps({ id: `strategy-${key}` }).props.onChange({ target: { value } })
    })
  const submit = () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} })
  await act(async () => {
    submit()
    submit()
  })
  assert.equal(calls.length, 1)
  assert.match(text(), /Preparation response unavailable/)
  assert.equal(renderer?.root.findByProps({ id: 'strategy-maxPrincipal' }).props.value, '10.25')
  await act(async () => submit())
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], calls[1])
})
test('deployed setup shows one explicit funding call, disabled start, pause and recovery controls', async () => {
  const setup = setupFixture()
  strategyApi.detail = async () => setup
  strategyApi.list = async () => ({ setups: [setup] })
  await mount(setup.id)
  assert.ok(button('Confirm this transaction in wallet'))
  assert.ok(button('Start this strategy')?.props.disabled)
  assert.ok(button('Review next funding step')?.props.disabled)
  assert.match(text(), /Transaction finalized|Awaiting your confirmation/)
  assert.match(text(), /Stopping AiKi does not cancel/)
  assert.ok(button('Reconcile pending execution'))
})
test('submitted action offers only its original receipt check, never another wallet send', async () => {
  const setup = setupFixture()
  setup.actions[0]!.status = 'SUBMITTED'
  setup.actions[0]!.transactionHash = `0x${'ab'.repeat(32)}`
  strategyApi.detail = async () => setup
  await mount(setup.id)
  assert.equal(button('Confirm this transaction in wallet'), undefined)
  assert.ok(button('Check original transaction'))
  assert.match(text(), /Waiting for finality/)
  assert.doesNotMatch(text(), /Automation is active/)
})
test('wallet revision change discards stale owner detail response', async () => {
  let resolve!: (value: ReturnType<typeof setupFixture>) => void
  strategyApi.detail = () =>
    new Promise((done) => {
      resolve = done
    })
  await mount('setup-1')
  await act(async () => {
    invalidateWalletSession()
    resolve(setupFixture())
  })
  assert.doesNotMatch(text(), /Verified vault|Deposit exactly 1 USDT/)
})

test('activity describes an actual wait and next check without promising a trade', async () => {
  const setup = setupFixture()
  setup.watch = {
    status: 'ACTIVE',
    nextRunAt: '2026-09-10T18:10:00Z',
    lastDecision: {
      code: 'NO_BENEFIT',
      reason: 'Waiting: benefit does not cover estimated gas.',
      at: '2026-09-10T18:05:00Z',
    },
    lastTransactionHash: null,
  }
  strategyApi.detail = async () => setup
  await mount(setup.id)
  assert.match(text(), /Waiting: benefit does not cover estimated gas/)
  assert.match(text(), /not a promised trade/)
  assert.doesNotMatch(text(), /Latest finalized execution receipt/)
})

test('uncertain watch activity offers recovery copy and only a verified finalized receipt link', async () => {
  const setup = setupFixture(),
    receipt = `0x${'ef'.repeat(32)}` as const
  setup.watch = {
    status: 'NEEDS_REVIEW',
    nextRunAt: '2026-09-10T18:10:00Z',
    lastDecision: null,
    lastTransactionHash: receipt,
  }
  strategyApi.detail = async () => setup
  await mount(setup.id)
  assert.match(text(), /New execution remains blocked/)
  assert.match(text(), /does not automatically restart/)
  assert.ok(
    renderer?.root
      .findAllByType('a')
      .some((a) => a.props.href === `https://bscscan.com/tx/${receipt}`),
  )
  assert.doesNotMatch(text(), /Next check:/)
})
