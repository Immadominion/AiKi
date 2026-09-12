import { expect, it, vi } from 'vitest'
import { resolveTaskEndpoint } from './support.js'

/**
 * An agent that speaks MCP is reachable.
 *
 * `aiki.task/v1` is AiKi's own envelope and a sweep of the registry found no
 * agent implementing it, while a small number expose real capabilities over
 * MCP. Those were unreachable, and the order of preference matters: an agent
 * that speaks AiKi's protocol should still be reached that way.
 */

const NATIVE = 'https://agent.example/task'
const MCP = 'https://provider.example/mcp/grid'

const nativeAnswer = (body: unknown) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as never

const dead = vi.fn(async () => {
  throw new Error('no route')
}) as never

const mcpSession = (tools: { name: string; description: string }[]) => {
  const close = vi.fn()
  return {
    close,
    connect: vi.fn(async () => ({
      version: '2025-06-18',
      tools: tools.map((tool) => ({ ...tool, inputSchema: {}, readAllowed: false })),
      truncated: false,
      call: async () => ({}),
      close,
    })),
  }
}

it('reaches an agent that speaks MCP and reports what it advertises', async () => {
  const s = mcpSession([
    { name: 'act', description: 'Places one grid order.' },
    { name: 'analyse', description: 'Reads the pool.' },
  ])
  const contact = await resolveTaskEndpoint(
    [{ protocol: 'MCP', endpoint: MCP }],
    dead,
    s.connect as never,
  )
  expect(contact.compatible).toBe(true)
  expect(contact.protocol).toBe('mcp')
  expect(contact.endpoint).toBe(MCP)
  expect(contact.tools?.map((tool) => tool.name)).toEqual(['act', 'analyse'])
  expect(s.close).toHaveBeenCalled()
})

it('still prefers AiKi task delivery when the agent speaks it', async () => {
  const s = mcpSession([{ name: 'act', description: '' }])
  const contact = await resolveTaskEndpoint(
    [
      { protocol: 'Web', endpoint: NATIVE },
      { protocol: 'MCP', endpoint: MCP },
    ],
    nativeAnswer({ taskProtocol: 'aiki.task/v1' }),
    s.connect as never,
  )
  expect(contact.protocol).toBe('aiki.task/v1')
  // No handshake was opened at all: the native path answered first.
  expect(s.connect).not.toHaveBeenCalled()
})

it('does not treat an MCP endpoint with no tools as hireable', async () => {
  const s = mcpSession([])
  const contact = await resolveTaskEndpoint(
    [{ protocol: 'MCP', endpoint: MCP }],
    dead,
    s.connect as never,
  )
  expect(contact.compatible).toBe(false)
  expect(contact.reason).toMatch(/does not answer AiKi task delivery or an MCP handshake/)
})

it('reports honestly when the handshake fails', async () => {
  const connect = vi.fn(async () => {
    throw new Error('unsupported protocol version')
  })
  const contact = await resolveTaskEndpoint(
    [{ protocol: 'MCP', endpoint: MCP }],
    dead,
    connect as never,
  )
  expect(contact.compatible).toBe(false)
  expect(connect).toHaveBeenCalledTimes(1)
})

it('only opens a handshake against endpoints declared as MCP', async () => {
  const s = mcpSession([{ name: 'act', description: '' }])
  const contact = await resolveTaskEndpoint(
    [{ protocol: 'A2A', endpoint: 'https://agent.example/a2a' }],
    dead,
    s.connect as never,
  )
  expect(s.connect).not.toHaveBeenCalled()
  expect(contact.compatible).toBe(false)
})

it('opens at most two handshakes however many are registered', async () => {
  const connect = vi.fn(async () => {
    throw new Error('nope')
  })
  await resolveTaskEndpoint(
    Array.from({ length: 8 }, (_entry, index) => ({
      protocol: 'MCP',
      endpoint: `https://p${index}.example/mcp`,
    })),
    dead,
    connect as never,
  )
  // Discovery is a real protocol conversation, not a HEAD request. One hire
  // must not become eight of them.
  expect(connect).toHaveBeenCalledTimes(2)
})

it('refuses a plaintext MCP endpoint', async () => {
  const connect = vi.fn()
  const contact = await resolveTaskEndpoint(
    [{ protocol: 'MCP', endpoint: 'http://provider.example/mcp' }],
    dead,
    connect as never,
  )
  expect(connect).not.toHaveBeenCalled()
  expect(contact.compatible).toBe(false)
})
