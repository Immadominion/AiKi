import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import type { CatalogAgent } from '../../lib/catalog-api'
import { ExploreView } from '../shell/ExploreView'

const originalFetch = globalThis.fetch
const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let renderer: ReactTestRenderer | undefined
const navigation: string[] = []
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  prefetch() {},
  bfcacheId: 'test',
  push(href) {
    navigation.push(href)
  },
  replace(href) {
    navigation.push(href)
  },
}
const agent: CatalogAgent = {
  id: '45650',
  chainId: 56,
  registry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  sourceId: '56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:45650',
  name: 'Provider from fixture',
  description: 'A registered description',
  imageUrl: null,
  ownerAddress: null,
  declaredProtocols: ['MCP'],
  declaredCategories: [],
  declaredPaymentSupport: false,
  services: [],
  source: {
    name: '8004scan',
    url: 'https://8004scan.io/agents/bsc/45650',
    retrievedAt: '2026-09-09T12:00:00Z',
  },
  taskAvailability: 'not_verified',
  connector: 'discovery_only',
}
function view(query: string) {
  return createElement(
    AppRouterContext.Provider,
    { value: router },
    createElement(
      SearchParamsContext.Provider,
      { value: new URLSearchParams(query) },
      createElement(ExploreView),
    ),
  )
}
function page(items = [agent]) {
  return {
    items,
    totalRegistered: 200,
    hasMore: true,
    nextCursor: 'next_page',
    categoryMatch: null,
    source: '8004scan',
    countMeaning: 'registered_agents_not_verified_working',
  }
}
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  globalThis.fetch = originalFetch
  navigation.length = 0
})
after(() => {
  if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf)
  else Reflect.deleteProperty(globalThis, 'self')
  if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

test('mounted Explore loads real rows and preserves protocol/search in next-page navigation', async () => {
  const requested: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    return Response.json(url.includes('?') ? page() : agent)
  }
  await act(async () => {
    renderer = create(view('q=Venus&protocol=MCP'))
  })
  assert.ok(JSON.stringify(renderer?.toJSON()).includes('Provider from fixture'))
  assert.ok(requested.some((url) => url.includes('query=Venus') && url.includes('protocol=MCP')))
  const next = renderer?.root
    .findAllByType('button')
    .find((button) => button.children.includes('Next page →'))
  assert.ok(next)
  await act(async () => next.props.onClick())
  assert.equal(navigation.at(-1), '/explore?q=Venus&protocol=MCP&cursor=next_page')
})

test('mounted Explore rejects a late response from an old filter', async () => {
  let oldResolve: (response: Response) => void = () => {}
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('query=old'))
      return new Promise((resolve) => {
        oldResolve = resolve
      })
    return Response.json(url.includes('?') ? page([{ ...agent, name: 'Current result' }]) : agent)
  }
  await act(async () => {
    renderer = create(view('q=old'))
  })
  assert.ok(renderer?.root.findByProps({ 'aria-label': 'Loading agent registrations' }))
  await act(async () => renderer?.update(view('q=new')))
  await act(async () => oldResolve(Response.json(page([{ ...agent, name: 'Stale result' }]))))
  const text = JSON.stringify(renderer?.toJSON())
  assert.ok(text.includes('Current result'))
  assert.equal(text.includes('Stale result'), false)
})

test('mounted Explore offers retry on failure and an honest empty state after recovery', async () => {
  let failed = true
  globalThis.fetch = async (input) => {
    if (!String(input).includes('?')) return Response.json(agent)
    return failed
      ? Response.json(
          { error: { code: 'SOURCE_DOWN', message: 'Source is temporarily unavailable.' } },
          { status: 502 },
        )
      : Response.json(page([]))
  }
  await act(async () => {
    renderer = create(view('q=no-match'))
  })
  assert.ok(JSON.stringify(renderer?.toJSON()).includes('Source is temporarily unavailable.'))
  const retry = renderer?.root
    .findAllByType('button')
    .find((button) => button.children.includes('Try again'))
  assert.ok(retry)
  failed = false
  await act(async () => retry.props.onClick())
  assert.ok(JSON.stringify(renderer?.toJSON()).includes('No registrations on this page'))
  assert.equal(JSON.stringify(renderer?.toJSON()).includes('Suggested'), false)
})
