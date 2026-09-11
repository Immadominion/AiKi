import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, afterEach, beforeEach, test } from 'node:test'
import type { ProjectedPassport } from '@aiki/contracts'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { ApiError, api } from '../../lib/api'
import { AgentTaskFields } from './AgentTaskForm'
import { buildAgentTask } from './agent-task'

const owner = `0x${'11'.repeat(20)}`
const agentId = '315943'
const key = 'f42eae28-b36e-48e4-9f7b-f74c24f81cc5'
const storageKey = `aiki.task-attempt:${owner}:${agentId}`
const draft = {
  agentId,
  title: 'Read my position',
  brief: 'Report collateral and debt. Do not trade.',
  kind: 'research',
  pricePoints: 1000,
  workHours: 24,
}
const request = buildAgentTask(draft)
const saved = {
  fingerprint: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
  key,
}
const passport = { agentId, name: 'Venus Guardian' } as ProjectedPassport
const support = { available: true, minimumPricePoints: 10, feeBasisPoints: 250 }
const account = {
  connected: true,
  authenticated: true,
  connectionPhase: 'idle' as const,
  connecting: false,
  ready: true,
  address: owner,
  walletKind: 'injected' as const,
  connect: async () => {
    throw new Error('No wallet prompts allowed')
  },
  disconnect() {},
}
type TaskResponse = Awaited<ReturnType<typeof api.postTask>>
const task: TaskResponse = {
  ...request,
  id: 'original-task',
  poster: owner,
  feePoints: 25,
  totalPoints: 1025,
  heldPoints: 1025,
  outlay: '1025',
  status: 'CLAIMED',
  workHours: 24,
  createdAt: '',
  updatedAt: '',
}
const originals = { credits: api.credits, postTask: api.postTask }
const globals = ['self', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
)
const storage = new Map<string, string>()
const navigation: string[] = []
const posts: { request: unknown; key: string | undefined }[] = []
let renderer: ReactTestRenderer | undefined
let balance = 0
let balanceFails = false
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  prefetch() {},
  bfcacheId: 'hire-test',
  push(href) {
    navigation.push(href)
  },
  replace(href) {
    navigation.push(href)
  },
}
function view(address = owner) {
  return createElement(
    AppRouterContext.Provider,
    { value: router },
    createElement(AgentTaskFields, {
      key: `${address}:${agentId}`,
      passport,
      support,
      account: { ...account, address },
    }),
  )
}
async function mount(address = owner) {
  await act(async () => {
    renderer = create(view(address))
  })
  await fill()
}
async function fill() {
  for (const [id, value] of [
    ['task-title', draft.title],
    ['task-brief', draft.brief],
    ['task-offer', '1000'],
  ]) {
    await act(async () => renderer?.root.findByProps({ id }).props.onChange({ target: { value } }))
  }
}
const button = () => renderer?.root.findByProps({ type: 'submit' })
const text = () => JSON.stringify(renderer?.toJSON())
const submit = () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} })
beforeEach(() => {
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => storage.set(name, value),
      removeItem: (name: string) => storage.delete(name),
    },
  })
  balance = 0
  balanceFails = false
  api.credits = async () => {
    if (balanceFails) throw new Error('Balance temporarily unavailable')
    return {
      balance,
      worthUsd: 0,
      pointsPerUsdt: 10000,
      minimumToAsk: 200,
      model: 'test',
      history: [],
    }
  }
  api.postTask = async (body, operationKey) => {
    posts.push({ request: body, key: operationKey })
    return task
  }
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  Object.assign(api, originals)
  storage.clear()
  navigation.length = 0
  posts.length = 0
})
after(() => {
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

test('saved exact request remains reachable with a post-charge zero balance and reuses its key', async () => {
  storage.set(storageKey, JSON.stringify(saved))
  await mount()
  assert.equal(button()?.props.disabled, false)
  assert.match(text(), /Check original request/)
  await act(async () => submit())
  assert.deepEqual(posts, [{ request, key }])
  assert.deepEqual(navigation, ['/work?task=original-task'])
  assert.equal(storage.has(storageKey), false)
})

test('an unavailable balance cannot block an exact saved request recovery', async () => {
  balanceFails = true
  storage.set(storageKey, JSON.stringify(saved))
  await mount()
  assert.equal(button()?.props.disabled, false)
  await act(async () => submit())
  assert.equal(posts[0]?.key, key)
})

test('changed work cannot reuse a prior operation or bypass a low balance', async () => {
  storage.set(storageKey, JSON.stringify(saved))
  await mount()
  await act(async () =>
    renderer?.root
      .findByProps({ id: 'task-brief' })
      .props.onChange({ target: { value: 'A different job' } }),
  )
  assert.equal(button()?.props.disabled, true)
  await act(async () => submit())
  assert.equal(posts.length, 0)
  assert.equal(storage.get(storageKey), JSON.stringify(saved))
})

test('a new request with insufficient points offers checkout and never posts', async () => {
  await mount()
  assert.equal(button()?.props.disabled, true)
  assert.ok(
    renderer?.root
      .findAllByType('a')
      .some(
        (node) =>
          node.children.includes('Add points') && node.props.href === '/credits#credit-add-title',
      ),
  )
  await act(async () => submit())
  assert.equal(posts.length, 0)
  assert.equal(storage.size, 0)
})

test('an uncertain response keeps the exact key for in-memory retry when storage is blocked', async () => {
  balance = 2000
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
      removeItem() {
        throw new Error('blocked')
      },
    },
  })
  api.postTask = async (body, operationKey) => {
    posts.push({ request: body, key: operationKey })
    balance = 0
    balanceFails = true
    throw new ApiError(503, 'TASK_FUNDING_UNCONFIRMED', 'Check the original request.', true)
  }
  await mount()
  await act(async () => submit())
  assert.equal(button()?.props.disabled, false)
  assert.match(text(), /Unavailable/)
  // A failed balance lookup is not evidence that the funded request failed.
  api.postTask = async (body, operationKey) => {
    posts.push({ request: body, key: operationKey })
    return task
  }
  await act(async () => submit())
  assert.equal(posts.length, 2)
  assert.equal(posts[0]?.key, posts[1]?.key)
  assert.deepEqual(posts[0]?.request, posts[1]?.request)
})

test('a confirmed pre-charge refusal clears its retry key and requires a new balance', async () => {
  balance = 2000
  api.postTask = async () => {
    balance = 0
    throw new ApiError(402, 'INSUFFICIENT_POINTS', 'Add points to continue.', false)
  }
  await mount()
  await act(async () => submit())
  assert.equal(storage.size, 0)
  assert.equal(button()?.props.disabled, true)
  assert.doesNotMatch(text(), /Check original request/)
})

test("wallet-scoped storage never offers the previous wallet's recovery key", async () => {
  storage.set(storageKey, JSON.stringify(saved))
  await mount(`0x${'22'.repeat(20)}`)
  assert.equal(button()?.props.disabled, true)
  await act(async () => submit())
  assert.equal(posts.length, 0)
})

test('double submit posts once and keeps new-purchase wording while the response is pending', async () => {
  balance = 2000
  let complete: (value: TaskResponse) => void = () => {}
  api.postTask = async (body, operationKey) => {
    posts.push({ request: body, key: operationKey })
    return new Promise((resolve) => {
      complete = resolve
    })
  }
  await mount()
  let pending: Promise<void> | undefined
  await act(async () => {
    pending = submit()
    void submit()
  })
  assert.equal(posts.length, 1)
  assert.equal(button()?.props.disabled, true)
  assert.match(text(), /Sending your request/)
  assert.doesNotMatch(text(), /Checking your request/)
  const stored = JSON.parse(storage.get(storageKey) ?? 'null')
  assert.deepEqual(Object.keys(stored).sort(), ['fingerprint', 'key'])
  assert.equal(stored.fingerprint, saved.fingerprint)
  assert.equal(JSON.stringify(stored).includes(draft.brief), false)
  await act(async () => {
    complete(task)
    await pending
  })
})

test('a late result for a disconnected wallet cannot navigate the new wallet to its task', async () => {
  balance = 2000
  let complete: (value: TaskResponse) => void = () => {}
  api.postTask = async () =>
    new Promise((resolve) => {
      complete = resolve
    })
  await mount()
  let pending: Promise<void> | undefined
  await act(async () => {
    pending = submit()
  })
  await act(async () => renderer?.update(view(`0x${'22'.repeat(20)}`)))
  await act(async () => {
    complete(task)
    await pending
  })
  assert.equal(navigation.length, 0)
  assert.equal(renderer?.root.findByProps({ id: 'task-title' }).props.value, '')
  assert.equal(storage.has(storageKey), false)
})

test('malformed stored attempt cannot bypass balance checks', async () => {
  for (const raw of [
    '{',
    JSON.stringify({ ...saved, key: 'bad\nkey' }),
    JSON.stringify({ ...saved, key: '' }),
  ]) {
    storage.set(storageKey, raw)
    await mount()
    assert.equal(button()?.props.disabled, true)
    await act(async () => submit())
    assert.equal(posts.length, 0)
    await act(async () => renderer?.unmount())
    renderer = undefined
  }
})

test('a remount can recover the original body and UUID after a failed response', async () => {
  balance = 2000
  api.postTask = async (body, operationKey) => {
    posts.push({ request: body, key: operationKey })
    balance = 0
    throw new TypeError('Failed to fetch')
  }
  await mount()
  await act(async () => submit())
  await act(async () => renderer?.unmount())
  api.postTask = async (body, operationKey) => {
    posts.push({ request: body, key: operationKey })
    return task
  }
  await mount()
  assert.equal(button()?.props.disabled, false)
  await act(async () => submit())
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[0], posts[1])
})

for (const outcome of ['success', 'uncharged refusal'] as const) {
  test(`an old form's late ${outcome} cannot erase a newer request's recovery key`, async () => {
    balance = 3000
    let finish: () => void = () => {}
    api.postTask = async (body, operationKey) => {
      posts.push({ request: body, key: operationKey })
      if (posts.length === 1)
        return new Promise((resolve, reject) => {
          finish = () =>
            outcome === 'success'
              ? resolve(task)
              : reject(new ApiError(402, 'INSUFFICIENT_POINTS', 'Not charged.', false))
        })
      throw new TypeError('Second response unavailable')
    }
    await mount()
    let first: Promise<void> | undefined
    await act(async () => {
      first = submit()
    })
    await act(async () => renderer?.unmount())
    await mount()
    await act(async () =>
      renderer?.root
        .findByProps({ id: 'task-brief' })
        .props.onChange({ target: { value: 'Another position report' } }),
    )
    await act(async () => submit())
    const secondAttempt = storage.get(storageKey)
    assert.ok(secondAttempt)
    assert.notEqual(posts[0]?.key, posts[1]?.key)
    await act(async () => {
      finish()
      await first
    })
    assert.equal(storage.get(storageKey), secondAttempt)
    assert.equal(navigation.length, 0)
  })
}
