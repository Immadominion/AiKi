import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { CatalogAgent } from '../../lib/catalog-api'
import { catalogApi } from '../../lib/catalog-api'
import {
  acceptWalletSession,
  invalidateWalletSession,
  walletSession,
} from '../../lib/wallet-session'
import { confirmedCatalogHireHref, loadCatalogHireHref } from './catalog-hiring'
import { catalogFilterHref, catalogFilters, readArguments } from './catalog-state'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateWalletSession()
})

test('catalog filters survive shared URLs and reject invalid protocol/category values', () => {
  assert.deepEqual(
    catalogFilters(
      new URLSearchParams('q=Venus&protocol=MCP&category=health_factor&cursor=abc_12'),
    ),
    { limit: 24, query: 'Venus', protocol: 'MCP', category: 'health_factor', cursor: 'abc_12' },
  )
  for (const query of [
    'protocol=ftp',
    'category=made_up',
    'cursor=https://localhost',
    `q=${'a'.repeat(161)}`,
  ])
    assert.throws(() => catalogFilters(new URLSearchParams(query)))
})
test('changing filters resets pagination while next page preserves every filter', () => {
  const original = new URLSearchParams('q=Venus&protocol=MCP&cursor=old')
  assert.equal(
    catalogFilterHref(original, { category: 'health_factor' }),
    '/explore?q=Venus&protocol=MCP&category=health_factor',
  )
  assert.equal(
    catalogFilterHref(original, { cursor: 'next' }),
    '/explore?q=Venus&protocol=MCP&cursor=next',
  )
  assert.equal(catalogFilterHref(original, { q: '', protocol: '' }), '/explore')
})
test('read forms emit only explicit supported mainnet read arguments', () => {
  const wallet = '0x1111111111111111111111111111111111111111'
  assert.deepEqual(readArguments('getDexInfo', '', wallet), { chainName: 'bsc' })
  assert.deepEqual(readArguments('getAccountLiquidity', 'CORE', wallet), {
    chainNames: ['bsc'],
    pool: 'CORE',
    userAddress: wallet,
  })
  assert.throws(() => readArguments('swap', '', wallet))
  assert.throws(() => readArguments('getAccountLiquidity', 'INVALID', wallet))
  assert.throws(() => readArguments('getAccountLiquidity', 'CORE', ''))
})
test('catalog client uses accepted-wallet binding on the actual private request', async () => {
  invalidateWalletSession()
  const wallet = '0x1111111111111111111111111111111111111111'
  acceptWalletSession(wallet, walletSession().revision)
  let sent = false
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/v1/catalog/agents/45650/read')
    assert.equal(init?.credentials, 'include')
    assert.equal(new Headers(init?.headers).get('x-aiki-wallet-address'), wallet)
    assert.deepEqual(JSON.parse(String(init?.body)), {
      tool: 'getDexInfo',
      arguments: { chainName: 'bsc' },
    })
    sent = true
    return Response.json({ status: 'completed' })
  }
  await catalogApi.read('45650', 'getDexInfo', { chainName: 'bsc' })
  assert.equal(sent, true)
})
test('catalog client discards an old read result when the wallet changes mid-flight', async () => {
  invalidateWalletSession()
  acceptWalletSession('0x1111111111111111111111111111111111111111', walletSession().revision)
  let finish: (response: Response) => void = () => {}
  globalThis.fetch = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const operation = catalogApi.read('45650', 'getDexInfo', { chainName: 'bsc' })
  invalidateWalletSession()
  acceptWalletSession('0x2222222222222222222222222222222222222222', walletSession().revision)
  finish(Response.json({ status: 'completed', content: 'old wallet result' }))
  await assert.rejects(operation, /wallet changed/i)
})
test('unsigned catalog browsing does not attach another tab’s cookie', async () => {
  invalidateWalletSession()
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.credentials, 'omit')
    assert.equal(new Headers(init?.headers).has('x-aiki-wallet-address'), false)
    return Response.json({ items: [] })
  }
  await catalogApi.list({ protocol: 'A2A' })
})

const hiringAgent = {
  id: '315943',
  chainId: 56,
  registry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  sourceId: '56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:315943',
} as CatalogAgent
const matchingPassport = {
  agentId: hiringAgent.id,
  chainId: hiringAgent.chainId,
  registry: hiringAgent.registry,
}

test('catalog hiring links require exact registered identity and actual task support', () => {
  assert.equal(
    confirmedCatalogHireHref(hiringAgent, matchingPassport, { available: true }),
    '/registry/315943/hire',
  )
  assert.equal(
    confirmedCatalogHireHref(
      hiringAgent,
      { ...matchingPassport, registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' },
      { available: true },
    ),
    '/registry/315943/hire',
  )
  for (const passport of [
    { ...matchingPassport, agentId: '315944' },
    { ...matchingPassport, chainId: 1 },
    { ...matchingPassport, chainId: null },
    { ...matchingPassport, registry: null },
    { ...matchingPassport, registry: '0x1111111111111111111111111111111111111111' },
  ])
    assert.equal(confirmedCatalogHireHref(hiringAgent, passport, { available: true }), null)
  assert.equal(confirmedCatalogHireHref(hiringAgent, matchingPassport, { available: false }), null)
  assert.equal(
    confirmedCatalogHireHref({ ...hiringAgent, sourceId: '56:wrong:315943' }, matchingPassport, {
      available: true,
    }),
    null,
  )
})

test('unindexed or failed support checks never create a catalog hire link', async () => {
  assert.equal(
    await loadCatalogHireHref(hiringAgent, {
      passport: async () => {
        throw new Error('not indexed')
      },
      taskSupport: async () => ({ available: true }),
    }),
    null,
  )
  assert.equal(
    await loadCatalogHireHref(hiringAgent, {
      passport: async () => matchingPassport,
      taskSupport: async () => {
        throw new Error('temporarily unavailable')
      },
    }),
    null,
  )
  assert.equal(
    await loadCatalogHireHref(hiringAgent, {
      passport: async () => matchingPassport,
      taskSupport: async () => ({ available: false }),
    }),
    null,
  )
})

test('catalog hiring checks use the existing passport and task-support endpoints, without quotes or payment', async () => {
  const paths: string[] = []
  globalThis.fetch = async (input, init) => {
    paths.push(String(input))
    assert.equal(init?.method, undefined)
    return Response.json(
      String(input).endsWith('/passport') ? matchingPassport : { available: true },
    )
  }
  assert.equal(await loadCatalogHireHref(hiringAgent), '/registry/315943/hire')
  assert.deepEqual(paths.sort(), ['/v1/agents/315943/passport', '/v1/agents/315943/task-support'])
})
