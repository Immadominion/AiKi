import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, test } from 'node:test'
import type { ProjectedPassport } from '@aiki/contracts'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import { act, createElement, Fragment } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { CatalogDetail } from '../components/catalog/CatalogDetail'
import { AgentTaskForm } from '../components/hire/AgentTaskForm'
import { StrategySetup } from '../components/strategies/StrategySetup'
import { MockProvider, useMock } from '../mock/store'
import { api } from './api'
import { catalogApi } from './catalog-api'
import { selectWallet } from './wallet'
import { invalidateWalletSession } from './wallet-session'

const owner = `0x${'11'.repeat(20)}`
const agentId = '45650'
const registry = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'
const passport = { agentId, name: 'Test provider' } as ProjectedPassport
const support = { available: true, minimumPricePoints: 10, feeBasisPoints: 250 }
const originals = {
  fetch: globalThis.fetch,
  detail: catalogApi.detail,
  capabilities: catalogApi.capabilities,
  passport: api.passport,
  taskSupport: api.taskSupport,
}
const globals = ['window', 'self', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
)
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  prefetch() {},
  push() {},
  replace() {},
  bfcacheId: 'wallet-phase-test',
}
let renderer: ReactTestRenderer | undefined
let account: ReturnType<typeof useMock>
let finishAccounts: (() => void) | undefined
let declineSignature: (() => void) | undefined
let accountCalls = 0
let signatureCalls = 0

function AccountProbe() {
  account = useMock()
  return null
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    value: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'window', {
    value: Object.assign(new EventTarget(), {
      location: { host: 'useaiki.xyz', origin: 'https://useaiki.xyz' },
    }),
    configurable: true,
  })
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    configurable: true,
  })
  accountCalls = 0
  signatureCalls = 0
  selectWallet({
    uuid: 'wallet-phase',
    name: 'Mock wallet only',
    rdns: 'test.wallet-phase',
    icon: '',
    provider: {
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts') {
          accountCalls++
          return new Promise<string[]>((resolve) => {
            finishAccounts = () => resolve([owner])
          })
        }
        if (method === 'eth_accounts') return [owner]
        if (method === 'eth_chainId') return '0x38'
        if (method === 'personal_sign') {
          signatureCalls++
          return new Promise<string>((_resolve, reject) => {
            declineSignature = () => reject(new Error('User rejected'))
          })
        }
        throw new Error('Unexpected wallet method in local mocked test')
      },
    },
  })
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path.endsWith('/logout')) return Response.json({ ok: true })
    if (path.endsWith('/nonce')) return Response.json({ nonce: 'testnonce12345678' })
    throw new Error('Unexpected network request in local mocked test')
  }
  catalogApi.detail = async () => ({
    id: agentId,
    chainId: 56,
    registry,
    sourceId: `56:${registry}:${agentId}`,
    name: 'Test provider',
    description: 'Read-only test provider',
    imageUrl: null,
    ownerAddress: null,
    declaredProtocols: ['MCP'],
    declaredCategories: [],
    declaredPaymentSupport: false,
    services: [],
    source: { name: '8004scan', url: 'https://example.com/agent', retrievedAt: '' },
    taskAvailability: 'not_verified',
    connector: 'read_only_candidate',
  })
  catalogApi.capabilities = async () => ({
    agentId,
    status: 'available',
    checkedAt: '',
    message: 'Available for a read',
    protocol: 'MCP',
    protocolVersion: '2025-06-18',
    tools: [],
    readTools: [{ name: 'getDexInfo', label: 'Read pools', description: '', inputSchema: {} }],
    toolsTruncated: false,
    pricing: 'no_aiki_charge_provider_may_require_payment',
    declaredPaymentSupport: false,
  })
  api.passport = async () => passport
  api.taskSupport = async () => ({ ...support, available: false })
})

afterEach(async () => {
  await act(async () => {
    finishAccounts?.()
    declineSignature?.()
    renderer?.unmount()
  })
  renderer = undefined
  finishAccounts = undefined
  declineSignature = undefined
  globalThis.fetch = originals.fetch
  catalogApi.detail = originals.detail
  catalogApi.capabilities = originals.capabilities
  api.passport = originals.passport
  api.taskSupport = originals.taskSupport
  invalidateWalletSession()
})
after(() => {
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

const surfaces = {
  catalog: () => createElement(CatalogDetail, { agentId }),
  hire: () => createElement(AgentTaskForm, { passport, support }),
  strategy: () => createElement(StrategySetup, { kind: 'yield' }),
}

for (const [name, surface] of Object.entries(surfaces)) {
  test(`${name} uses shared wallet progress across its account remount and recovers after decline`, async () => {
    await act(async () => {
      renderer = create(
        createElement(
          AppRouterContext.Provider,
          { value: router },
          createElement(
            MockProvider,
            null,
            createElement(Fragment, null, createElement(AccountProbe), surface()),
          ),
        ),
      )
    })
    let pending: ReturnType<typeof account.connect> | undefined
    await act(async () => {
      pending = account.connect()
    })
    const control = (label: string) =>
      renderer?.root.findAllByType('button').find((button) => button.children.includes(label))
    const waiting = control('Waiting for your wallet')
    assert.ok(waiting)
    assert.equal(waiting.props.disabled, true)
    assert.equal(waiting.props['aria-busy'], true)
    assert.equal(accountCalls, 1)

    await act(async () => finishAccounts?.())
    assert.equal(account.connectionPhase, 'signing')
    const signing = control('Check your wallet to sign in')
    assert.ok(signing)
    assert.equal(signing.props.disabled, true)
    assert.equal(signing.props['aria-busy'], true)
    assert.equal(signatureCalls, 1)

    await act(async () => {
      declineSignature?.()
      assert.equal(await pending, 'unsigned')
    })
    const retry = control(name === 'catalog' ? 'Connect and sign in' : 'Sign in')
    assert.ok(retry)
    assert.equal(retry.props.disabled, false)
    assert.equal(retry.props['aria-busy'], false)
    assert.equal(accountCalls, 1)
    assert.equal(signatureCalls, 1)
  })
}
