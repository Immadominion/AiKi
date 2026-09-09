import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { ProjectedPassport } from '@aiki/contracts'
import { guardianFor } from '@aiki/contracts/guardian'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { api } from '../../lib/api'
import { invalidateWalletSession } from '../../lib/wallet-session'
import { MockProvider } from '../../mock/store'
import { RegistryHire } from '../registry/RegistryHire'
import { GuardianNetworkGate } from './MandateBuilder'
import { guardianSubjectFromPassport, hireSubjectFromFixture, isGuardianPassport } from './subject'

const manager = `0x${'33'.repeat(20)}`
const network = (chainId: number) => {
  const guardian = guardianFor(chainId)
  return { configured: true, chainId, network: guardian.network, audited: false, manager, guardian }
}
const passport = {
  agentId: '315943',
  chainId: 56,
  registry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  name: 'Venus Guardian',
  liveness: 'LIVE',
  identity: {
    tokenId: '315943',
    registrationFile: { resolved: true, reciprocalProofVerified: true },
  },
} as ProjectedPassport
const originals = {
  fetch: globalThis.fetch,
  passport: api.passport,
  taskSupport: api.taskSupport,
  preview: api.previewMandate,
}
const globals = new Map(
  ['self', 'window', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
)
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => null, setItem() {} },
  configurable: true,
})
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let renderer: ReactTestRenderer | undefined
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  prefetch() {},
  push() {},
  replace() {},
  bfcacheId: 'test',
}
const rendered = () => JSON.stringify(renderer?.toJSON())
const button = (label: string) =>
  renderer?.root.findAllByType('button').find((node) => node.children.includes(label))
const gate = () =>
  createElement(GuardianNetworkGate, {
    subject: hireSubjectFromFixture('guardian'),
    // A render function is not a ReactNode; this gate deliberately uses a render prop.
    // biome-ignore lint/correctness/noChildrenProp: typed render-function child
    children: (subject) => createElement('output', null, JSON.stringify(subject)),
  })
const registry = (agentId = '315943') =>
  createElement(
    AppRouterContext.Provider,
    { value: router },
    createElement(MockProvider, null, createElement(RegistryHire, { agentId })),
  )

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  globalThis.fetch = originals.fetch
  api.passport = originals.passport
  api.taskSupport = originals.taskSupport
  api.previewMandate = originals.preview
  invalidateWalletSession()
})
after(() => {
  for (const [key, previous] of globals) {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('Guardian identity requires the exact chain, registry, token and verified registration, not name', () => {
  assert.equal(isGuardianPassport(passport), true)
  assert.equal(guardianSubjectFromPassport(passport).guardianActivation, true)
  for (const other of [
    { ...passport, agentId: '315944' },
    { ...passport, chainId: 97 },
    { ...passport, registry: manager },
    { ...passport, liveness: 'UNPROBED' },
    { ...passport, identity: { ...passport.identity, tokenId: '999' } },
    {
      ...passport,
      identity: {
        ...passport.identity,
        registrationFile: { ...passport.identity.registrationFile, reciprocalProofVerified: false },
      },
    },
  ]) {
    assert.equal(isGuardianPassport(other as ProjectedPassport), false)
    assert.throws(() => guardianSubjectFromPassport(other as ProjectedPassport))
  }
})

test('mounted gate refuses missing metadata, offers retry, then selects the verified runtime', async () => {
  let available = false
  const requests: RequestInit[] = []
  globalThis.fetch = async (_url, init) => {
    requests.push(init ?? {})
    return Response.json(available ? network(56) : {}, { status: available ? 200 : 503 })
  }
  await act(async () => {
    renderer = create(gate())
  })
  assert.equal(renderer?.root.findAllByType('output').length, 0)
  assert.ok(rendered().includes('Repayment setup is unavailable'))
  const retry = button('Try again')
  assert.ok(retry)
  available = true
  await act(async () => retry.props.onClick())
  assert.ok(rendered().includes(guardianFor(56).market))
  assert.ok(rendered().includes(guardianFor(56).asset))
  assert.equal(rendered().includes(guardianFor(97).market), false)
  assert.ok(
    requests.every((request) => request.cache === 'no-store' && request.method === undefined),
  )
})

test('mounted gate ignores the previous wallet network response', async () => {
  let resolveOld: (response: Response) => void = () => {}
  let count = 0
  globalThis.fetch = async () =>
    ++count === 1
      ? new Promise((resolve) => {
          resolveOld = resolve
        })
      : Response.json(network(97))
  await act(async () => {
    renderer = create(gate())
  })
  await act(async () => {
    invalidateWalletSession()
  })
  assert.ok(rendered().includes(guardianFor(97).market))
  await act(async () => resolveOld(Response.json(network(56))))
  assert.ok(rendered().includes(guardianFor(97).market))
  assert.equal(rendered().includes(guardianFor(56).market), false)
})

test('malformed canonical inputs never mount a signing form', async () => {
  const wrong = network(56)
  wrong.guardian.market = guardianFor(97).market
  globalThis.fetch = async () => Response.json(wrong)
  await act(async () => {
    renderer = create(gate())
  })
  assert.equal(renderer?.root.findAllByType('output').length, 0)
  assert.ok(button('Try again'))
})

function registryMocks(heldPassport = passport) {
  const paths: string[] = []
  api.passport = async () => heldPassport
  api.taskSupport = async () => ({
    available: true,
    minimumPricePoints: 10,
    feeBasisPoints: 250,
    kinds: ['research'],
  })
  api.previewMandate = async () => ({ network: 'mainnet', audited: false, tier: 'T2', limits: [] })
  globalThis.fetch = async (url) => {
    const path = String(url)
    paths.push(path)
    if (path === '/v1/auth/logout') return Response.json({ ok: true })
    if (path === '/v1/execution/network') return Response.json(network(56))
    throw new Error(`Unexpected mocked request ${path}`)
  }
  return paths
}

test('real Guardian registry hire preserves reports and explicitly opts into repayment setup', async () => {
  const paths = registryMocks()
  await act(async () => {
    renderer = create(registry())
  })
  assert.ok(button('Set up automatic repayment'))
  assert.ok(rendered().includes('Request work from'))
  assert.equal(paths.includes('/v1/execution/network'), false)
  await act(async () => button('Set up automatic repayment')?.props.onClick())
  assert.equal(renderer?.root.findAllByType('form').length, 0)
  assert.ok(button('Connect wallet to continue'))
  assert.ok(rendered().includes('The Venus USDT debt must belong to your mandate account'))
  assert.ok(rendered().includes('no watch starts here'))
  await act(async () => button('Request a report')?.props.onClick())
  assert.ok(rendered().includes('Request work from'))
  assert.equal(button('Connect wallet to continue'), undefined)
  assert.equal(
    paths.some((path) => path === '/v1/account' || path === '/v1/authorizations'),
    false,
  )
})

test('a similarly named agent keeps report hiring and cannot acquire Guardian activation', async () => {
  const paths = registryMocks({
    ...passport,
    agentId: '315944',
    identity: { ...passport.identity, tokenId: '315944' },
  })
  await act(async () => {
    renderer = create(registry('315944'))
  })
  assert.ok(rendered().includes('Request work from'))
  assert.equal(button('Set up automatic repayment'), undefined)
  assert.equal(paths.includes('/v1/execution/network'), false)
})

test('a route change removes the old identity before the next passport arrives', async () => {
  registryMocks()
  await act(async () => {
    renderer = create(registry())
  })
  assert.ok(button('Set up automatic repayment'))
  api.passport = async () => new Promise(() => {})
  await act(async () => renderer?.update(registry('315944')))
  assert.equal(button('Set up automatic repayment'), undefined)
})
