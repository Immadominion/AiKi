import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import {
  ApiError,
  type AssistantTurn,
  api,
  type CreditBalance,
  type FastConversation,
} from '../../lib/api'
import { ConnectedCredits } from '../credits/CreditsView'
import { FastChat } from './FastChat'
import {
  addPointsHref,
  errorNeedsPoints,
  fastCostSummary,
  fastReturnHref,
  messageNeedsPoints,
} from './FastPoints'

const id = '12345678-1234-4123-8123-123456789012',
  owner = `0x${'11'.repeat(20)}`
const message =
  'This turn needs 644 points available; you have 445. No points were charged and no tools ran. Add points to continue.'
const cost = {
  points: 0,
  balance: 445,
  held: 445,
  explanation: 'No provider usage. The unused reservation was released.',
}
const original = {
  credits: api.credits,
  conversation: api.conversation,
  createConversation: api.createConversation,
  assistant: api.assistant,
  treasury: api.treasury,
  depositCredits: api.depositCredits,
}
const globals = ['IS_REACT_ACT_ENVIRONMENT', 'window', 'self'].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
)
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
let renderer: ReactTestRenderer | undefined
let asks = 0
const storage = new Map<string, string>()
const balance: CreditBalance = {
  balance: 445,
  worthUsd: 0.0445,
  pointsPerUsdt: 10000,
  minimumToAsk: 200,
  model: 'Local test',
  history: [],
}
const conversation = (
  content = message,
  billing: AssistantTurn['cost'] = cost,
): FastConversation => ({
  id,
  title: 'Read my position',
  createdAt: '',
  updatedAt: '',
  messageCount: 2,
  lastMessage: content,
  messages: [
    {
      id: 'user',
      turnId: 'turn',
      role: 'user',
      content: 'Read my Venus position. Do not transact.',
      createdAt: '',
    },
    {
      id: 'reply',
      turnId: 'turn',
      role: 'assistant',
      status: 'failed',
      content,
      steps: [],
      cost: billing,
      createdAt: '',
    },
  ],
})
function prepare(saved = conversation()) {
  asks = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { href: `https://aiki.test/app?conversation=${id}`, search: `?conversation=${id}` },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  })
  api.credits = async () => balance
  api.conversation = async () => saved
  api.createConversation = async () => saved
  api.assistant = async () => {
    asks++
    throw new Error('No model calls allowed in this test')
  }
}
const text = () => JSON.stringify(renderer?.toJSON())
const addPoints = () =>
  renderer?.root.findAllByType('a').filter((node) => node.children.includes('Add points')) ?? []
async function mountChat() {
  await act(async () => {
    renderer = create(createElement(FastChat, { id, owner }))
  })
}
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  Object.assign(api, original)
  storage.clear()
})
after(() => {
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('saved insufficient-points history offers checkout and explains USDT without rerunning a turn', async () => {
  prepare()
  await mountChat()
  assert.equal(addPoints().length, 1)
  const link = addPoints()[0]
  assert.equal(link?.props.href, `/credits?conversation=${id}#credit-add-title`)
  assert.match(link?.props.className ?? '', /min-h-11/)
  assert.match(link?.props.className ?? '', /focus-visible/)
  assert.match(text(), /Holding USDT in your wallet does not add points/)
  assert.match(text(), /No points charged/)
  assert.doesNotMatch(text(), /of the 445 held went back/)
  assert.equal(asks, 0)
})

test('checkout explains a purchase and links back to the exact conversation', async () => {
  prepare()
  api.treasury = async () => ({
    chainId: 56,
    decimals: 18,
    finality: 'finalized',
    token: '0x55d398326f99059ff775485246999027b3197955',
    treasury: `0x${'22'.repeat(20)}`,
    pointsPerUsdt: 10000,
    confirmations: 3,
  })
  api.depositCredits = async () => {
    throw new Error('No payment writes allowed')
  }
  await act(async () => {
    renderer = create(createElement(ConnectedCredits, { address: owner }))
  })
  assert.match(text(), /Holding USDT in your wallet does not add points/)
  const link = renderer?.root
    .findAllByType('a')
    .find((node) => node.children.includes('Back to this conversation'))
  assert.equal(link?.props.href, `/app?conversation=${id}`)
  assert.equal(asks, 0)
})

test('a live pre-charge refusal offers checkout and preserves the unsent draft across a remount', async () => {
  const empty = { ...conversation(), messages: [], messageCount: 0, lastMessage: null }
  prepare(empty)
  api.assistant = async () => {
    asks++
    throw new ApiError(402, 'ASSISTANT_NO_CREDIT', 'Fast mode needs more points.', false)
  }
  await mountChat()
  await act(async () =>
    renderer?.root.findByType('textarea').props.onChange({ target: { value: 'Read my position' } }),
  )
  await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.equal(addPoints().length, 1)
  assert.equal(renderer?.root.findByType('textarea').props.value, 'Read my position')
  assert.equal(asks, 1)
  await act(async () => renderer?.unmount())
  await mountChat()
  assert.equal(renderer?.root.findByType('textarea').props.value, 'Read my position')
  assert.equal(asks, 1)
})

test('a newly persisted budget refusal has one recovery action, not a duplicate alert', async () => {
  const empty = { ...conversation(), messages: [], messageCount: 0, lastMessage: null }
  prepare(empty)
  api.assistant = async () => {
    asks++
    api.conversation = async () => conversation()
    throw new ApiError(402, 'ASSISTANT_BUDGET_TOO_SMALL', message, false)
  }
  // Controller captures its transport at mount, so keep the same load function.
  api.conversation = async () => (asks ? conversation() : empty)
  await mountChat()
  await act(async () =>
    renderer?.root.findByType('textarea').props.onChange({ target: { value: 'Read my position' } }),
  )
  await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.equal(addPoints().length, 1)
  assert.equal(renderer?.root.findAll((node) => node.props.role === 'alert').length, 0)
  assert.equal(renderer?.root.findByType('textarea').props['aria-describedby'], undefined)
  assert.match(text(), /No points charged/)
  assert.equal(asks, 1)
})

test('a per-turn hard limit does not suggest that buying points can raise it', async () => {
  const capped =
    'This turn needs 2500 points reserved. That exceeds the 2000 point limit per turn. No points were charged and no tools ran. More points will not raise this limit. Use Manual mode instead.'
  prepare(conversation(capped))
  await mountChat()
  assert.equal(addPoints().length, 0)
  assert.equal(errorNeedsPoints('ASSISTANT_BUDGET_TOO_SMALL', capped), false)
  assert.match(text(), /More points will not raise this limit/)
})

test('pending usage keeps its reservation explicit and never gets a zero-charge final claim or purchase CTA', async () => {
  prepare(conversation('Usage still needs confirmation.', { ...cost, pendingPoints: 445 }))
  await mountChat()
  assert.equal(addPoints().length, 0)
  assert.match(text(), /0 points charged so far/)
  assert.match(text(), /445 points still reserved pending confirmation/)
  assert.doesNotMatch(text(), /No points charged|held went back/)
})

test('an uncertain live request stays locked to Check reply, including after remount', async () => {
  const empty = { ...conversation(), messages: [], messageCount: 0, lastMessage: null }
  prepare(empty)
  api.assistant = async () => {
    asks++
    throw new ApiError(
      503,
      'ASSISTANT_HOLD_UNCONFIRMED',
      'The points hold could not be confirmed.',
      false,
    )
  }
  await mountChat()
  await act(async () =>
    renderer?.root.findByType('textarea').props.onChange({ target: { value: 'Do this once' } }),
  )
  await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.equal(addPoints().length, 0)
  assert.match(text(), /Check reply/)
  assert.equal(renderer?.root.findByType('textarea').props.readOnly, true)
  await act(async () => renderer?.unmount())
  await mountChat()
  assert.equal(asks, 1)
  assert.equal(renderer?.root.findByType('textarea').props.readOnly, true)
})

test('ordinary successful model text, unrelated failures and rate limits cannot create a points recovery action', () => {
  const saved = conversation().messages[1]
  assert.ok(saved)
  assert.equal(messageNeedsPoints({ ...saved, status: 'completed' }), false)
  assert.equal(messageNeedsPoints({ ...saved, role: 'user' }), false)
  assert.equal(messageNeedsPoints({ ...saved, content: `The provider said: ${message}` }), false)
  assert.equal(messageNeedsPoints({ ...saved, cost: { ...cost, points: 1 } }), false)
  assert.equal(messageNeedsPoints({ ...saved, cost: { ...cost, pendingPoints: 1 } }), false)
  assert.equal(
    messageNeedsPoints({
      ...saved,
      steps: [{ tool: 'read_external_agent', input: {}, ok: true, mutating: false }],
    }),
    false,
  )
  assert.equal(errorNeedsPoints('ASSISTANT_RATE_LIMITED', message), false)
  assert.equal(errorNeedsPoints('ASSISTANT_USAGE_UNCONFIRMED', message), false)
  assert.equal(errorNeedsPoints(undefined, message), false)
})

test('settled and pending billing summaries distinguish confirmed charges from reservations', () => {
  assert.equal(fastCostSummary(cost), 'No points charged · 445 points remaining after this turn')
  assert.equal(
    fastCostSummary({ ...cost, points: 12 }),
    '12 points charged · 445 points remaining after this turn',
  )
  assert.equal(
    fastCostSummary({ ...cost, points: 12, pendingPoints: 433 }),
    '12 points charged so far · 433 points still reserved pending confirmation',
  )
  assert.equal(fastCostSummary({ ...cost, points: Number.NaN }), 'Billing details unavailable.')
  assert.equal(fastCostSummary({ ...cost, pendingPoints: -1 }), 'Billing details unavailable.')
})

test('checkout return paths allow only the conversation ID and ignore redirect payloads', () => {
  assert.equal(addPointsHref(id), `/credits?conversation=${id}#credit-add-title`)
  assert.equal(
    fastReturnHref(`?conversation=${id}&returnTo=https://evil.invalid&message=private`),
    `/app?conversation=${id}`,
  )
  for (const value of [
    '//evil.invalid',
    'https://evil.invalid',
    '../work',
    `${id}&other=value`,
    'javascript:alert(1)',
  ]) {
    assert.equal(addPointsHref(value), '/credits#credit-add-title')
    assert.equal(fastReturnHref(`?conversation=${encodeURIComponent(value)}`), '/app')
  }
  assert.equal(fastReturnHref('?returnTo=https://evil.invalid'), '/app')
})
