import { expect, it, vi } from 'vitest'
import { dispatchOverA2A, dispatchOverMcp } from './dispatch.js'
import { resolveTaskEndpoint } from './support.js'

/**
 * Telling an agent what it needs to know.
 *
 * Written against a real hire that failed. Lattice (341554) was paid ten points
 * over A2A and answered "the task does not state lower bound, upper bound,
 * capital, stop price, fee per trade in bps". The task was resent with every
 * one of those written into the prose and got the identical refusal, because a
 * parameterised agent reads a data part and does not parse English.
 *
 * The money is the point. Every one of these failures happens AFTER the buyer
 * has paid, so a marketplace that cannot carry parameters sells refusals.
 */

const RPC = 'https://marque.example/agents/lattice/a2a'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

it('sends what the buyer filled in as data AND as lines, because the ecosystem is split', async () => {
  const sent: RequestInit[] = []
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(init)
    return json({
      jsonrpc: '2.0',
      result: { kind: 'message', parts: [{ kind: 'text', text: 'ok' }] },
    })
  })
  await dispatchOverA2A({
    url: RPC,
    title: 'Plan a grid',
    brief: 'prose for a person',
    intent: '11111111-1111-4111-8111-111111111111',
    skill: 'grid-plan',
    agentInput: { lowerBound: 560, upperBound: 640, levels: 8, capital: 100 },
    fetcher: fetcher as never,
  })
  const parts = JSON.parse(String(sent[0]?.body)).params.message.parts
  /*
   * Measured, not guessed. Lattice reported a value missing when it was sent as
   * data and present when the same value sat in the prose, so it reads the text
   * part. SMEAI delivered from a data part. A marketplace does not get to pick
   * which half of the ecosystem its buyers reach.
   */
  expect(parts[0].text).toBe(
    'Plan a grid\n\nprose for a person\n\nlowerBound: 560\nupperBound: 640\nlevels: 8\ncapital: 100',
  )
  expect(parts[1]).toEqual({
    kind: 'data',
    data: { lowerBound: 560, upperBound: 640, levels: 8, capital: 100, skill: 'grid-plan' },
  })
})

it('leaves the text alone when the buyer filled in nothing', async () => {
  const sent: RequestInit[] = []
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(init)
    return json({
      jsonrpc: '2.0',
      result: { kind: 'message', parts: [{ kind: 'text', text: 'ok' }] },
    })
  })
  await dispatchOverA2A({
    url: RPC,
    title: 'Plan a grid',
    brief: 'prose for a person',
    intent: '11111111-1111-4111-8111-111111111111',
    skill: 'grid-plan',
    fetcher: fetcher as never,
  })
  expect(JSON.parse(String(sent[0]?.body)).params.message.parts[0].text).toBe(
    'Plan a grid\n\nprose for a person',
  )
})

it('does not repeat the skill in the lines, and renders a value that is not a scalar', async () => {
  const sent: RequestInit[] = []
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(init)
    return json({
      jsonrpc: '2.0',
      result: { kind: 'message', parts: [{ kind: 'text', text: 'ok' }] },
    })
  })
  await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: '11111111-1111-4111-8111-111111111111',
    skill: 'grid-plan',
    // `skill` names the purchase and is already its own field in the data part;
    // repeating it as prose invites an agent to read it as a parameter.
    agentInput: { skill: 'act', pools: ['0xaa', '0xbb'], live: true },
    fetcher: fetcher as never,
  })
  const text = JSON.parse(String(sent[0]?.body)).params.message.parts[0].text
  expect(text).not.toMatch(/skill:/)
  expect(text).toMatch(/pools: \["0xaa","0xbb"\]/)
  expect(text).toMatch(/live: true/)
})

it('will not let buyer input overwrite the capability that was paid for', async () => {
  const sent: RequestInit[] = []
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(init)
    return json({
      jsonrpc: '2.0',
      result: { kind: 'message', parts: [{ kind: 'text', text: 'ok' }] },
    })
  })
  await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: '11111111-1111-4111-8111-111111111111',
    skill: 'grid-plan',
    agentInput: { skill: 'act' },
    fetcher: fetcher as never,
  })
  const parts = JSON.parse(String(sent[0]?.body)).params.message.parts
  // `act` places a real order. Buying one capability and calling another is the
  // one substitution this must never make.
  expect(parts[1].data.skill).toBe('grid-plan')
})

it('still sends a data part for the skill alone when nothing was filled in', async () => {
  const sent: RequestInit[] = []
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(init)
    return json({
      jsonrpc: '2.0',
      result: { kind: 'message', parts: [{ kind: 'text', text: 'ok' }] },
    })
  })
  await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: '11111111-1111-4111-8111-111111111111',
    skill: 'grid-plan',
    fetcher: fetcher as never,
  })
  expect(JSON.parse(String(sent[0]?.body)).params.message.parts[1].data).toEqual({
    skill: 'grid-plan',
  })
})

it.each(['input-required', 'auth-required', 'failed', 'rejected', 'canceled'])(
  'does not record work for a task the agent reports as %s',
  async (state) => {
    const fetcher = vi.fn(async () =>
      json({
        jsonrpc: '2.0',
        result: {
          kind: 'task',
          status: {
            state,
            message: { parts: [{ kind: 'text', text: 'a grid needs bounds, capital and a stop' }] },
          },
        },
      }),
    )
    const out = await dispatchOverA2A({
      url: RPC,
      title: 't',
      brief: 'b',
      intent: '11111111-1111-4111-8111-111111111111',
      fetcher: fetcher as never,
    })
    expect(out.declined).toBe(true)
    expect(out.delivered).toBeUndefined()
    expect(out.note).toMatch(/a grid needs bounds/)
  },
)

it('records completed work, and a bare message that states no task state', async () => {
  const completed = vi.fn(async () =>
    json({
      jsonrpc: '2.0',
      result: {
        kind: 'task',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ kind: 'text', text: 'four levels' }] }],
      },
    }),
  )
  const done = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: '11111111-1111-4111-8111-111111111111',
    fetcher: completed as never,
  })
  expect(done.delivered).toBe('four levels')

  // A message has no state at all, and an absent state is not a refusal.
  const message = vi.fn(async () =>
    json({ jsonrpc: '2.0', result: { kind: 'message', parts: [{ kind: 'text', text: 'plan' }] } }),
  )
  const bare = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: '11111111-1111-4111-8111-111111111111',
    fetcher: message as never,
  })
  expect(bare.delivered).toBe('plan')
  expect(bare.declined).toBeUndefined()
})

it('relays an MCP tool schema instead of dropping it at discovery', async () => {
  const schema = {
    type: 'object',
    properties: { pool: { type: 'string' }, levels: { type: 'number' } },
    required: ['pool'],
  }
  const connect = vi.fn(async () => ({
    version: '2025-06-18',
    tools: [{ name: 'act', description: 'Places one order.', inputSchema: schema }],
    truncated: false,
    call: async () => ({}),
    close: vi.fn(),
  }))
  const contact = await resolveTaskEndpoint(
    [{ name: 'MCP', endpoint: 'https://provider.example/mcp' }],
    vi.fn(async () => {
      throw new Error('no route')
    }) as never,
    connect as never,
  )
  // Without this a buyer is sold a tool with no way to learn what it takes.
  expect(contact.tools?.[0]?.inputSchema).toEqual(schema)
})

it('drops a schema too large for anybody to read, and keeps the tool', async () => {
  const connect = vi.fn(async () => ({
    version: '2025-06-18',
    tools: [
      {
        name: 'act',
        description: 'Places one order.',
        inputSchema: { type: 'object', note: 'x'.repeat(20_000) },
      },
    ],
    truncated: false,
    call: async () => ({}),
    close: vi.fn(),
  }))
  const contact = await resolveTaskEndpoint(
    [{ name: 'MCP', endpoint: 'https://provider.example/mcp' }],
    vi.fn(async () => {
      throw new Error('no route')
    }) as never,
    connect as never,
  )
  expect(contact.compatible).toBe(true)
  expect(contact.tools?.[0]?.name).toBe('act')
  expect(contact.tools?.[0]?.inputSchema).toBeUndefined()
})

it('passes the buyer arguments to the MCP tool, over AiKi’s own three', async () => {
  const called: unknown[] = []
  const connect = vi.fn(async () => ({
    version: '2025-06-18',
    tools: [{ name: 'act', description: '', inputSchema: {} }],
    truncated: false,
    call: async (_name: string, args: unknown) => {
      called.push(args)
      return { content: [{ type: 'text', text: 'placed' }] }
    },
    close: vi.fn(),
  }))
  await dispatchOverMcp({
    endpoint: 'https://provider.example/mcp',
    tool: 'act',
    arguments: { intentId: 'task-1', brief: 'prose', title: 'ours', pool: '0xabc' },
    connect: connect as never,
  })
  expect(called[0]).toEqual({
    intentId: 'task-1',
    brief: 'prose',
    title: 'ours',
    pool: '0xabc',
  })
})

/*
 * The exact payload a real agent sent, three times, after being paid.
 *
 * A2A offers three ways to decline and this one uses none of them: an ordinary
 * message whose text is an error object. Recorded as delivered, it charged ten
 * points for a list of what the buyer had failed to say. A decline refunds.
 */
it('refunds when the whole answer is an error object, and relays what it needs', async () => {
  const fetcher = vi.fn(async () =>
    json({
      jsonrpc: '2.0',
      result: {
        kind: 'message',
        parts: [
          {
            kind: 'text',
            text: JSON.stringify({
              error: 'the task does not state lower bound, upper bound, capital',
              need: 'a grid needs bounds, capital, a level count, a stop and a per-trade fee',
            }),
          },
        ],
      },
    }),
  )
  const out = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: '11111111-1111-4111-8111-111111111111',
    fetcher: fetcher as never,
  })
  expect(out.declined).toBe(true)
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/does not state lower bound/)
  expect(out.note).toMatch(/It needs: a grid needs bounds/)
})

it('does not call real work a refusal for mentioning an error', async () => {
  // The rule is the whole body being an error object, not the word appearing.
  // A plan that reports a failed level is a plan, and it was paid for.
  const delivered = JSON.stringify({
    levels: [560, 570, 580],
    spacing: 'geometric',
    notes: 'one level failed an error check and was skipped',
  })
  const fetcher = vi.fn(async () =>
    json({
      jsonrpc: '2.0',
      result: { kind: 'message', parts: [{ kind: 'text', text: delivered }] },
    }),
  )
  const out = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: '11111111-1111-4111-8111-111111111111',
    fetcher: fetcher as never,
  })
  expect(out.delivered).toBe(delivered)
  expect(out.declined).toBeUndefined()
})

it.each([
  ['an empty error', { error: '   ' }],
  ['an error that is not a string', { error: { code: 7 } }],
  ['no error at all', { levels: 4 }],
])('treats %s as work rather than a refusal', async (_label, payload) => {
  const fetcher = vi.fn(async () =>
    json({
      jsonrpc: '2.0',
      result: { kind: 'message', parts: [{ kind: 'text', text: JSON.stringify(payload) }] },
    }),
  )
  const out = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: '11111111-1111-4111-8111-111111111111',
    fetcher: fetcher as never,
  })
  expect(out.declined).toBeUndefined()
  expect(out.delivered).toBeTruthy()
})

it.each(['submitted', 'working'])(
  'returns the points for a task still %s, without calling it a refusal',
  async (state) => {
    // Finishing one means polling or a push, and this side does neither yet.
    // Charging for an answer nobody is coming to fetch is the failure; blaming
    // the agent for something missing here is a different one.
    const fetcher = vi.fn(async () =>
      json({ jsonrpc: '2.0', result: { kind: 'task', status: { state } } }),
    )
    const out = await dispatchOverA2A({
      url: RPC,
      title: 't',
      brief: 'b',
      intent: '11111111-1111-4111-8111-111111111111',
      fetcher: fetcher as never,
    })
    expect(out.declined).toBe(true)
    expect(out.delivered).toBeUndefined()
    expect(out.note).toMatch(/still running it/)
    expect(out.note).not.toMatch(/Declined/)
  },
)
