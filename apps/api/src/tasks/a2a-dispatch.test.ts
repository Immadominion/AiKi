import { expect, it, vi } from 'vitest'
import { dispatchOverA2A } from './dispatch.js'
import { resolveTaskEndpoint } from './support.js'

/**
 * A2A is the largest group that answers anything on this chain.
 *
 * Both halves here were written against what probing actually returned, not
 * against the specification. A real card sits at a per-agent path and names a
 * separate JSON-RPC url, and the largest publisher on this chain registered a
 * template nobody filled in.
 */

const CARD = 'https://marque.example/agents/lattice/.well-known/agent-card.json'
const RPC = 'https://marque.example/agents/lattice/a2a'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const card = {
  name: 'Lattice',
  protocolVersion: '0.3.0',
  url: RPC,
  preferredTransport: 'JSONRPC',
  skills: [
    { id: 'grid-plan', name: 'Plan a bounded grid', description: 'Levels and spacing.' },
    { id: 'fee-drag', name: 'Disclose fee drag', description: 'Total fee cost.' },
  ],
}

it('sends the work as a text part and reads the answer back', async () => {
  const sent: RequestInit[] = []
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(init)
    return json({
      jsonrpc: '2.0',
      id: 'task-1',
      result: { kind: 'message', parts: [{ kind: 'text', text: 'four levels' }] },
    })
  })
  const out = await dispatchOverA2A({
    url: RPC,
    title: 'Plan a grid',
    brief: 'WBNB/USDT, 1% band',
    intent: 'task-1',
    skill: 'grid-plan',
    fetcher: fetcher as never,
  })
  expect(out.delivered).toBe('four levels')
  const body = JSON.parse(String(sent[0]?.body))
  expect(body.method).toBe('message/send')
  // messageId is required by the protocol and is the task id, so a retry is the
  // same message rather than a second one.
  expect(body.params.message.messageId).toBe('task-1')
  expect(body.params.message.parts[0].text).toMatch(/Plan a grid/)
  expect(body.params.message.parts[1]).toEqual({ kind: 'data', data: { skill: 'grid-plan' } })
})

it('reads text out of a task with artifacts, not only a bare message', async () => {
  const fetcher = vi.fn(async () =>
    json({
      jsonrpc: '2.0',
      result: {
        kind: 'task',
        status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'done' }] } },
        artifacts: [{ parts: [{ kind: 'text', text: 'the report' }] }],
      },
    }),
  )
  const out = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: 'task-2',
    fetcher: fetcher as never,
  })
  expect(out.delivered).toBe('done\nthe report')
})

it('treats a JSON-RPC error as a decline, because that is how A2A says no', async () => {
  const fetcher = vi.fn(async () =>
    json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'no task text found in the message parts' },
    }),
  )
  const out = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: 'task-3',
    fetcher: fetcher as never,
  })
  expect(out.declined).toBe(true)
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/no task text found/)
})

it('is not a delivery when the answer carries no text', async () => {
  const fetcher = vi.fn(async () => json({ jsonrpc: '2.0', result: { kind: 'task', status: {} } }))
  const out = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: 'task-4',
    fetcher: fetcher as never,
  })
  expect(out.delivered).toBeUndefined()
  expect(out.declined).toBeUndefined()
})

it('records an unreachable agent without deciding it either way', async () => {
  const fetcher = vi.fn(async () => {
    throw new Error('connect ECONNREFUSED')
  })
  const out = await dispatchOverA2A({
    url: RPC,
    title: 't',
    brief: 'b',
    intent: 'task-5',
    fetcher: fetcher as never,
  })
  expect(out.declined).toBeUndefined()
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/Could not reach it over A2A/)
})

it('resolves a card from where the registration points, and names its skills', async () => {
  const read = vi.fn(async (url: string) => (url === CARD ? json(card) : json({}, 404)))
  const contact = await resolveTaskEndpoint([{ protocol: 'A2A', endpoint: CARD }], read as never)
  expect(contact.compatible).toBe(true)
  expect(contact.protocol).toBe('a2a')
  // The endpoint carried forward is the JSON-RPC url, never the card itself.
  expect(contact.endpoint).toBe(RPC)
  expect(contact.tools?.map((tool) => tool.name)).toEqual(['grid-plan', 'fee-drag'])
})

it('refuses a registration that never filled in its template', async () => {
  // Twelve hundred identities on this chain registered exactly this.
  const read = vi.fn(async () => json(card))
  const contact = await resolveTaskEndpoint(
    [{ protocol: 'A2A', endpoint: 'https://platform.example/api/v1/a2a/agents/{agentId}/card' }],
    read as never,
  )
  expect(read).not.toHaveBeenCalled()
  expect(contact.compatible).toBe(false)
})

it('falls back to the older well-known name when the newer one is absent', async () => {
  const origin = 'https://solo.example'
  const read = vi.fn(async (url: string) =>
    url === `${origin}/.well-known/agent.json`
      ? json({ ...card, url: `${origin}/a2a` })
      : json({}, 404),
  )
  const contact = await resolveTaskEndpoint(
    [{ protocol: 'A2A', endpoint: `${origin}/.well-known/agent-card.json` }],
    read as never,
  )
  expect(contact.compatible).toBe(true)
  expect(contact.endpoint).toBe(`${origin}/a2a`)
})

it('does not treat a card with no skills as something that can be bought', async () => {
  const read = vi.fn(async () => json({ ...card, skills: [] }))
  const contact = await resolveTaskEndpoint([{ protocol: 'A2A', endpoint: CARD }], read as never)
  expect(contact.compatible).toBe(false)
})

it('refuses a card whose call url is itself a template', async () => {
  const read = vi.fn(async () => json({ ...card, url: 'https://p.example/a2a/{agentId}' }))
  const contact = await resolveTaskEndpoint([{ protocol: 'A2A', endpoint: CARD }], read as never)
  expect(contact.compatible).toBe(false)
})
