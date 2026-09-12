import { expect, it, vi } from 'vitest'
import { dispatchOverMcp } from './dispatch.js'

/**
 * Hiring an agent over MCP, and staying uncredulous about the answer.
 *
 * The failure this guards against is the marketplace paying full price for the
 * word no. These providers answer an out-of-scope request with a well-formed
 * refusal rather than an exception, so "it responded" and "it did the work" are
 * different questions and only one of them releases money.
 */

const ENDPOINT = 'https://provider.example/mcp/grid'

const session = (over: Record<string, unknown> = {}) => {
  const close = vi.fn()
  return {
    close,
    connect: async () => ({
      version: '2025-06-18',
      tools: [{ name: 'act', description: '', inputSchema: {}, readAllowed: false }],
      truncated: false,
      call: async () => ({ content: [{ type: 'text', text: 'order placed, tx 0xabc' }] }),
      close,
      ...over,
    }),
  }
}

it('delivers the text a tool returned', async () => {
  const s = session()
  const out = await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: { intentId: 'task-1' },
    connect: s.connect as never,
  })
  expect(out.delivered).toBe('order placed, tx 0xabc')
  expect(out.declined).toBeUndefined()
  // The session is always closed, whatever happened.
  expect(s.close).toHaveBeenCalled()
})

it('treats a structured refusal as a decline, not as work', async () => {
  const s = session({
    call: async () => ({
      content: [{ type: 'text', text: 'Refused: 40 USDT is over the 10 USDT per-action cap.' }],
      isError: true,
    }),
  })
  const out = await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: {},
    connect: s.connect as never,
  })
  expect(out.declined).toBe(true)
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/over the 10 USDT per-action cap/)
})

it('declines with a usable sentence even when the error carries no text', async () => {
  const s = session({ call: async () => ({ content: [], isError: true }) })
  const out = await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: {},
    connect: s.connect as never,
  })
  expect(out.declined).toBe(true)
  expect(out.note).toMatch(/reported an error/)
})

it('refuses to call a tool the provider is no longer advertising', async () => {
  const call = vi.fn()
  const s = session({ tools: [{ name: 'analyse' }], call })
  const out = await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: {},
    connect: s.connect as never,
  })
  // An agent that has dropped the tool it was hired for is a different agent.
  expect(call).not.toHaveBeenCalled()
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/no longer offers a tool called act/)
})

it('is not a delivery when the answer has no text at all', async () => {
  const s = session({ call: async () => ({ content: [{ type: 'image', data: 'AAAA' }] }) })
  const out = await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: {},
    connect: s.connect as never,
  })
  expect(out.delivered).toBeUndefined()
  expect(out.declined).toBeUndefined()
  expect(out.note).toMatch(/nothing this protocol recognises as work/)
})

it('records an unreachable provider without calling it a decline', async () => {
  const out = await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: {},
    connect: (async () => {
      throw new Error('dns lookup failed')
    }) as never,
  })
  // A transport failure must not refund as though the agent said no, and must
  // not pay as though it said yes.
  expect(out.declined).toBeUndefined()
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/Could not reach it over MCP: dns lookup failed/)
})

it('records a failed call without deciding it either way, and still closes', async () => {
  const s = session({
    call: async () => {
      throw new Error('session expired')
    },
  })
  const out = await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: {},
    connect: s.connect as never,
  })
  expect(out.declined).toBeUndefined()
  expect(out.delivered).toBeUndefined()
  expect(out.note).toMatch(/the call failed: session expired/)
  expect(s.close).toHaveBeenCalled()
})

it('passes the arguments through exactly as given', async () => {
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }] }))
  const s = session({ call })
  await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: { intentId: 'task-7', side: 'sell' },
    connect: s.connect as never,
  })
  // The caller owns idempotency, because the caller is the side that recorded
  // the attempt before making it.
  expect(call).toHaveBeenCalledWith('act', { intentId: 'task-7', side: 'sell' })
})

it('joins multi-part text and caps what it will accept', async () => {
  const s = session({
    call: async () => ({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'image', data: 'AAAA' },
        { type: 'text', text: 'line two' },
      ],
    }),
  })
  const out = await dispatchOverMcp({
    endpoint: ENDPOINT,
    tool: 'act',
    arguments: {},
    connect: s.connect as never,
  })
  expect(out.delivered).toBe('line one\nline two')
})
