import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssistantTurn, FastConversation } from '../../lib/api'
import {
  type ConversationTransport,
  conversationContext,
  conversationStorageKey,
  FastConversationController,
} from './fast-conversation'

const id = '11111111-1111-4111-8111-111111111111'
const reply: AssistantTurn = {
  reply: 'Found an agent.',
  steps: [],
  truncated: false,
  cost: { points: 10, held: 200, balance: 990, explanation: 'Used 10 points.' },
}
const empty = (): FastConversation => ({
  id,
  title: 'New conversation',
  createdAt: '',
  updatedAt: '',
  messageCount: 0,
  lastMessage: null,
  messages: [],
})
function harness() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  let conversation = empty()
  const calls: Array<{ messages: unknown; options: unknown }> = []
  const transport: ConversationTransport = {
    create: async () => conversation,
    load: async () => conversation,
    ask: async (messages, options) => {
      calls.push({ messages, options })
      const question = messages.at(-1)
      assert.ok(question)
      conversation = {
        ...conversation,
        messages: [
          ...conversation.messages,
          {
            id: `${calls.length}:u`,
            turnId: `${calls.length}`,
            role: 'user',
            content: question.content,
            createdAt: '',
          },
          {
            id: `${calls.length}:a`,
            turnId: `${calls.length}`,
            role: 'assistant',
            content: reply.reply,
            steps: reply.steps,
            cost: reply.cost,
            createdAt: '',
          },
        ],
      }
      return reply
    },
  }
  let keys = 0
  const controller = (owner = '0xAB') =>
    new FastConversationController(id, owner, transport, storage, () => `key-${++keys}`)
  return { values, storage, transport, calls, controller }
}

test('a fresh explicit ask persists actual replies, while restored History never submits', async () => {
  const h = harness()
  const first = h.controller()
  await first.initialize(true, 'Find me an agent')
  assert.equal(h.calls.length, 1)
  assert.equal(first.getSnapshot().messages.length, 2)
  first.dispose()
  const restored = h.controller()
  await restored.initialize(false, 'Find me an agent')
  assert.equal(h.calls.length, 1)
  assert.equal(restored.getSnapshot().messages[1]?.content, 'Found an agent.')
})

test('a lost response preserves the exact request key and body across reload, without automatic retries', async () => {
  const h = harness()
  const send = h.transport.ask
  h.transport.ask = async (messages, options) => {
    await send(messages, options)
    throw new Error('Connection interrupted')
  }
  const first = h.controller()
  await first.initialize(true, 'Hire only with my limits')
  assert.equal(first.getSnapshot().pending?.idempotencyKey, 'key-1')
  first.dispose()
  const restored = h.controller()
  await restored.initialize()
  assert.equal(h.calls.length, 1)
  assert.equal(restored.getSnapshot().pending?.idempotencyKey, 'key-1')
  let retried: unknown
  h.transport.ask = async (messages, options) => {
    retried = { messages, options }
    return reply
  }
  await restored.send()
  assert.deepEqual(retried, h.calls[0])
  assert.equal(restored.getSnapshot().pending, null)
  assert.equal(restored.getSnapshot().messages.length, 2)
  assert.equal(h.values.size, 0)
})

test('draft and pending request state never cross wallet boundaries', async () => {
  const h = harness()
  const first = h.controller()
  await first.initialize()
  first.setDraft('Private wallet request')
  assert.equal(conversationStorageKey('0xAB', id), conversationStorageKey('0xab', id))
  const other = h.controller('0xcd')
  await other.initialize()
  assert.equal(other.getSnapshot().draft, '')
  const restored = h.controller('0xab')
  await restored.initialize()
  assert.equal(restored.getSnapshot().draft, 'Private wallet request')
})

test('thread switch ignores late responses and keeps a recoverable pending key', async () => {
  const h = harness()
  let finish!: (value: AssistantTurn) => void
  h.transport.ask = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const first = h.controller()
  await first.initialize()
  const sent = first.send('Do not lose this request')
  first.dispose()
  finish(reply)
  await sent
  assert.equal(first.getSnapshot().messages.length, 0)
  const restored = h.controller()
  await restored.initialize()
  assert.equal(restored.getSnapshot().pending?.idempotencyKey, 'key-1')
})

test('double submit cannot create another request while busy', async () => {
  const h = harness()
  let finish!: (value: AssistantTurn) => void
  let called = 0
  h.transport.ask = () => {
    called += 1
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const controller = h.controller()
  await controller.initialize()
  const sent = controller.send('Find an agent')
  await controller.send('Find an agent')
  assert.equal(called, 1)
  finish(reply)
  await sent
})

test('known pre-charge refusal preserves the draft but permits a new corrected request key', async () => {
  const h = harness()
  h.transport.ask = async () => {
    throw Object.assign(new Error('Add points first.'), {
      status: 402,
      code: 'ASSISTANT_NO_CREDIT',
    })
  }
  const controller = h.controller()
  await controller.initialize(true, 'Find an agent')
  assert.equal(controller.getSnapshot().pending, null)
  assert.equal(controller.getSnapshot().draft, 'Find an agent')
  let key = ''
  h.transport.ask = async (_messages, options) => {
    key = options.idempotencyKey
    return reply
  }
  await controller.send()
  assert.equal(key, 'key-2')
})

test('bounded context keeps complete recent pairs without mutating saved messages', () => {
  const messages = [
    { role: 'user' as const, content: 'Old question' },
    { role: 'assistant' as const, content: 'x'.repeat(7600) },
    { role: 'user' as const, content: 'Recent question' },
    { role: 'assistant' as const, content: 'Recent answer' },
  ]
  assert.deepEqual(conversationContext(messages, 'Next'), [
    ...messages.slice(2),
    { role: 'user', content: 'Next' },
  ])
  assert.equal(messages.length, 4)
})

test('a failed conversation creation preserves the opening draft without sending a paid request', async () => {
  const h = harness()
  h.transport.create = async () => {
    throw new Error('Could not create conversation')
  }
  const controller = h.controller()
  await controller.initialize(true, 'Keep this draft')
  assert.equal(controller.getSnapshot().draft, 'Keep this draft')
  assert.equal(h.calls.length, 0)
  assert.equal(
    JSON.parse(h.values.get(conversationStorageKey('0xab', id)) ?? '{}').draft,
    'Keep this draft',
  )
})

test('overlapping initialization does not submit the opening twice', async () => {
  const h = harness()
  const controller = h.controller()
  await Promise.all([
    controller.initialize(true, 'One ask'),
    controller.initialize(true, 'One ask'),
  ])
  assert.equal(h.calls.length, 1)
})

test('remounting original create props restores a pending key before saving the opening', async () => {
  const h = harness()
  let asks = 0
  h.transport.ask = async () => {
    asks++
    throw new Error('Reply not confirmed')
  }
  const first = h.controller()
  await first.initialize(true, 'Do this once')
  const original = first.getSnapshot().pending
  assert.equal(original?.idempotencyKey, 'key-1')
  first.dispose()
  const remounted = h.controller()
  await remounted.initialize(true, 'Do this once')
  assert.equal(asks, 1)
  assert.deepEqual(remounted.getSnapshot().pending, original)
  const stored = h.values.get(conversationStorageKey('0xab', id))
  assert.ok(stored)
  assert.deepEqual(JSON.parse(stored).pending, original)
})

test('a second mounted view sees a turn started while its conversation request was loading', async () => {
  const h = harness()
  let asks = 0
  let resolveCreate!: (value: FastConversation) => void
  const originalCreate = h.transport.create
  h.transport.create = () =>
    new Promise((resolve) => {
      resolveCreate = resolve
    })
  h.transport.ask = async () => {
    asks++
    throw new Error('Reply not confirmed')
  }
  const second = h.controller()
  const opening = second.initialize(true, 'Only once')
  h.transport.create = originalCreate
  const first = h.controller()
  await first.initialize(true, 'Only once')
  resolveCreate(empty())
  await opening
  assert.equal(asks, 1)
  assert.deepEqual(second.getSnapshot().pending, first.getSnapshot().pending)
})

test('malformed browser drafts never crash history restoration or start a turn', async () => {
  for (const pending of [
    { idempotencyKey: 'key', messages: [null] },
    { idempotencyKey: 'key', messages: [0] },
    { idempotencyKey: 'key', messages: [{ role: 'user' }] },
    { idempotencyKey: '\n', messages: [{ role: 'user', content: 'x' }] },
  ]) {
    const h = harness()
    h.values.set(conversationStorageKey('0xab', id), JSON.stringify({ pending }))
    const controller = h.controller()
    await controller.initialize()
    assert.equal(controller.getSnapshot().error, null)
    assert.equal(controller.getSnapshot().pending, null)
    assert.equal(h.calls.length, 0)
  }
})

test('reinitializing without browser storage keeps the in-memory request key', async () => {
  const h = harness()
  let asks = 0
  h.transport.ask = async () => {
    asks++
    throw new Error('Reply not confirmed')
  }
  const controller = new FastConversationController(
    id,
    '0xab',
    h.transport,
    undefined,
    () => 'original-key',
  )
  await controller.initialize(true, 'Only once')
  await controller.initialize(true, 'Only once')
  assert.equal(asks, 1)
  assert.equal(controller.getSnapshot().pending?.idempotencyKey, 'original-key')
})

function savedFailure(
  h: ReturnType<typeof harness>,
  code: 'ASSISTANT_USAGE_UNCONFIRMED' | 'ASSISTANT_BUDGET_TOO_SMALL' | 'ASSISTANT_TURN_FAILED',
) {
  const persist = h.transport.ask
  const load = h.transport.load
  const requests: Array<{ messages: unknown; options: unknown }> = []
  let saved = false
  const uncertain = code === 'ASSISTANT_USAGE_UNCONFIRMED'
  const content = uncertain
    ? 'Your task was created. Later usage needs confirmation.'
    : 'Shorten this request before asking again.'
  const cost = {
    points: uncertain ? 10 : 0,
    balance: uncertain ? 800 : 1000,
    held: 200,
    explanation: uncertain
      ? '10 points confirmed, 190 still held.'
      : 'No provider usage. All points returned.',
    ...(uncertain ? { pendingPoints: 190 } : {}),
  }
  const steps = uncertain ? [{ tool: 'post_task', input: {}, ok: true, mutating: true }] : []
  h.transport.ask = async (messages, options) => {
    requests.push({ messages, options })
    if (!saved) {
      await persist(messages, options)
      saved = true
    }
    throw Object.assign(new Error(content), {
      status: code === 'ASSISTANT_BUDGET_TOO_SMALL' ? 402 : 503,
      code,
    })
  }
  h.transport.load = async (conversationId) => {
    const conversation = await load(conversationId)
    return {
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.role === 'assistant' ? { ...message, content, cost, steps } : message,
      ),
    }
  }
  return { requests, content, cost, steps, persist }
}

test('an uncertain saved outcome shows partial work and held points without unlocking or repeating work', async () => {
  const h = harness()
  const recorded = savedFailure(h, 'ASSISTANT_USAGE_UNCONFIRMED')
  const first = h.controller()
  await first.initialize(true, 'Create this task once')
  assert.equal(first.getSnapshot().messages.length, 2)
  assert.equal(first.getSnapshot().messages[1]?.content, recorded.content)
  assert.deepEqual(first.getSnapshot().messages[1]?.steps, recorded.steps)
  assert.deepEqual(first.getSnapshot().messages[1]?.cost, recorded.cost)
  assert.equal(first.getSnapshot().pending?.idempotencyKey, 'key-1')
  assert.equal(first.getSnapshot().draft, 'Create this task once')
  assert.equal(first.getSnapshot().busy, false)
  await first.send('A different task must not replace this pending request')
  assert.deepEqual(recorded.requests[1], recorded.requests[0])
  assert.equal(h.calls.length, 1)
  assert.equal(first.getSnapshot().pending?.idempotencyKey, 'key-1')
  first.dispose()
  const restored = h.controller()
  await restored.initialize()
  assert.equal(recorded.requests.length, 2)
  assert.equal(restored.getSnapshot().messages[1]?.cost?.pendingPoints, 190)
  assert.equal(restored.getSnapshot().pending?.idempotencyKey, 'key-1')
})

test('a saved budget refusal is visible and becomes context before a fresh corrected request', async () => {
  const h = harness()
  const recorded = savedFailure(h, 'ASSISTANT_BUDGET_TOO_SMALL')
  const controller = h.controller()
  await controller.initialize(true, 'Too much context')
  assert.equal(controller.getSnapshot().messages[1]?.content, recorded.content)
  assert.deepEqual(controller.getSnapshot().messages[1]?.cost, recorded.cost)
  assert.equal(controller.getSnapshot().pending, null)
  assert.equal(controller.getSnapshot().draft, '')
  assert.equal(h.values.size, 0)
  h.transport.ask = recorded.persist
  await controller.send('Shorter request')
  assert.deepEqual(h.calls[1], {
    messages: [
      { role: 'user', content: 'Too much context' },
      { role: 'assistant', content: recorded.content },
      { role: 'user', content: 'Shorter request' },
    ],
    options: { conversationId: id, idempotencyKey: 'key-2' },
  })
})

for (const code of [
  'ASSISTANT_USAGE_UNCONFIRMED',
  'ASSISTANT_BUDGET_TOO_SMALL',
  'ASSISTANT_TURN_FAILED',
] as const)
  test(`${code} preserves its request key if saved history cannot be loaded`, async () => {
    const h = harness()
    const recorded = savedFailure(h, code)
    const load = h.transport.load
    h.transport.load = async () => {
      throw new Error('History temporarily unavailable')
    }
    const controller = h.controller()
    await controller.initialize(true, 'Keep the original turn')
    assert.equal(controller.getSnapshot().pending?.idempotencyKey, 'key-1')
    assert.equal(controller.getSnapshot().busy, false)
    assert.equal(controller.getSnapshot().messages.length, 0)
    h.transport.load = load
    await controller.send()
    assert.deepEqual(recorded.requests[1], recorded.requests[0])
    assert.equal(h.calls.length, 1)
    assert.equal(controller.getSnapshot().messages.length, 2)
    assert.equal(
      controller.getSnapshot().pending?.idempotencyKey ?? null,
      code === 'ASSISTANT_USAGE_UNCONFIRMED' ? 'key-1' : null,
    )
  })
