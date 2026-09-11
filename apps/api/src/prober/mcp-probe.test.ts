import { describe, expect, it, vi } from 'vitest'
import type { guardedFetch } from '../net/guard.js'
import { probeAgent } from './probe.js'

const registry = 'eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'
const endpoint = 'https://provider.example/mcp/venus'
const tools = [{ name: 'borrow', inputSchema: { type: 'object' } }]

function fixture(
  options: {
    reciprocal?: 'match' | 'wrong-agent' | 'wrong-registry'
    status?: number
    empty?: boolean
    malformed?: boolean
    failFirst?: boolean
    invalidSchema?: boolean
  } = {},
) {
  const calls: { url: string; method: string; rpc?: string; headers: Headers }[] = []
  const read: typeof guardedFetch = vi.fn<typeof guardedFetch>(async (input, init = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const rpc = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({
      url,
      method,
      ...(rpc ? { rpc: rpc.method } : {}),
      headers: new Headers(init.headers),
    })
    if (method === 'GET' && url.endsWith('/.well-known/agent-registration.json')) {
      if (!options.reciprocal) return new Response(null, { status: 404 })
      return Response.json({
        registrations: [
          {
            agentId: options.reciprocal === 'wrong-agent' ? '999' : '43129',
            agentRegistry:
              options.reciprocal === 'wrong-registry' ? registry.replace(':56:', ':97:') : registry,
          },
        ],
      })
    }
    if (method === 'GET') return new Response(null, { status: 405 })
    if (options.status || (options.failFirst && url === endpoint))
      return new Response(null, { status: options.status ?? 503 })
    if (rpc.method === 'initialize')
      return Response.json(
        {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'Provider', version: '1' },
          },
        },
        { headers: { 'mcp-session-id': 'private-session-value' } },
      )
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (rpc.method === 'tools/list')
      return Response.json({
        jsonrpc: '2.0',
        id: options.malformed ? 99 : rpc.id,
        result: {
          tools: options.empty
            ? []
            : options.invalidSchema
              ? [{ name: 'broken', inputSchema: {} }]
              : tools,
        },
      })
    throw new Error('Unexpected financial/tool method')
  })
  return { read, calls }
}

const run = (read: typeof guardedFetch, services = [{ name: 'MCP', endpoint }]) =>
  probeAgent({ agentId: '43129', registry, services, read })

describe('protocol-aware MCP liveness, not tool execution', () => {
  it('uses the MCP lifecycle when GET would return 405, without calling an advertised tool', async () => {
    const f = fixture({ reciprocal: 'match' })
    const result = await run(f.read)
    expect(result.verdict).toMatchObject({
      state: 'LIVE',
      rule: 'MCP-D8',
      evidence: {
        protocol: 'MCP',
        protocolAvailable: true,
        toolCount: 1,
      },
    })
    expect(f.calls.filter((c) => c.method === 'POST').map((c) => c.rpc)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ])
    expect(f.calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      'https://provider.example/.well-known/agent-registration.json',
    ])
    expect(f.calls.every((c) => !c.headers.has('authorization') && !c.headers.has('cookie'))).toBe(
      true,
    )
    expect(JSON.stringify(result)).not.toContain('private-session-value')
  })
  it.each([undefined, 'wrong-agent', 'wrong-registry'] as const)(
    'keeps available but identity-unproven MCP degraded (%s)',
    async (reciprocal) => {
      const f = fixture(reciprocal ? { reciprocal } : {})
      expect((await run(f.read)).verdict).toMatchObject({
        state: 'DEGRADED',
        rule: 'MCP-identity-unproven',
        evidence: { protocolAvailable: true, toolCount: 1 },
      })
    },
  )
  it('does not mistake a valid empty tool list for an executable capability', async () => {
    const f = fixture({ reciprocal: 'match', empty: true })
    expect((await run(f.read)).verdict).toMatchObject({
      state: 'DEGRADED',
      rule: 'MCP-no-tools',
      evidence: { protocolAvailable: true, toolCount: 0 },
    })
  })
  it('does not treat malformed tool schemas as usable capability definitions', async () => {
    const f = fixture({ reciprocal: 'match', invalidSchema: true })
    expect((await run(f.read)).verdict).toMatchObject({
      state: 'DEGRADED',
      rule: 'MCP-no-tools',
      evidence: { protocolAvailable: true, toolCount: 0 },
    })
  })
  it.each([401, 403, 402])(
    'records an access requirement for HTTP %s without authenticating or paying',
    async (status) => {
      const f = fixture({ status })
      expect((await run(f.read)).verdict).toMatchObject({
        state: 'DEGRADED',
        evidence: {
          protocolAvailable: false,
          accessRequired: status === 402 ? 'payment' : 'authentication',
        },
      })
      expect(f.calls.map((c) => c.rpc).filter(Boolean)).toEqual(['initialize'])
    },
  )
  it('refuses mismatched JSON-RPC response identity', async () => {
    const f = fixture({ reciprocal: 'match', malformed: true })
    expect((await run(f.read)).verdict).toMatchObject({
      state: 'DEGRADED',
      evidence: { protocolAvailable: false },
    })
  })
  it('tries the declared MCP endpoint before an unrelated website service', async () => {
    const f = fixture({ reciprocal: 'match' })
    expect(
      (
        await run(f.read, [
          { name: 'web', endpoint: 'https://provider.example/' },
          { name: 'mcp', endpoint },
        ])
      ).verdict.state,
    ).toBe('LIVE')
    expect(f.calls[0]).toMatchObject({ url: endpoint, method: 'POST', rpc: 'initialize' })
  })
  it('tries at most two distinct remote MCP endpoints and can use the second', async () => {
    const f = fixture({ reciprocal: 'match', failFirst: true })
    const second = 'https://provider.example/mcp/second'
    expect(
      (
        await run(
          f.read,
          [endpoint, endpoint, second, 'https://provider.example/mcp/third'].map((url) => ({
            name: 'MCP',
            endpoint: url,
          })),
        )
      ).verdict.state,
    ).toBe('LIVE')
    expect(f.calls.filter((c) => c.rpc === 'initialize').map((c) => c.url)).toEqual([
      endpoint,
      second,
    ])
  })
  it('never falls back to GET to claim failed MCP endpoints are live', async () => {
    const f = fixture({ status: 503 })
    const result = await run(
      f.read,
      [endpoint, `${endpoint}/2`, `${endpoint}/3`].map((url) => ({ name: 'MCP', endpoint: url })),
    )
    expect(result.verdict.state).toBe('UNREACHABLE')
    expect(f.calls).toHaveLength(2)
    expect(f.calls.every((c) => c.rpc === 'initialize')).toBe(true)
  })
  it('can evaluate a separately declared HTTP service after a failed MCP check', async () => {
    const f = fixture({ status: 503 })
    const read: typeof guardedFetch = async (url, init) => {
      if (String(url).includes('/agents/')) return Response.json({ requestedUrl: String(url) })
      return f.read(url, init)
    }
    const result = await run(read, [
      { name: 'MCP', endpoint },
      { name: 'aiki-agent', endpoint: 'https://provider.example/agents/43129' },
    ])
    expect(result.verdict).toMatchObject({
      state: 'LIVE',
      rule: 'D5',
      evidence: {
        mcp: { protocol: 'MCP', protocolAvailable: false },
      },
    })
  })
  it('does not promote an ordinary identifier-free JSON website into LIVE', async () => {
    const f = fixture()
    const read: typeof guardedFetch = async (url, init) =>
      url === 'https://provider.example/' ? Response.json({ hello: true }) : f.read(url, init)
    expect(
      (await run(read, [{ name: 'web', endpoint: 'https://provider.example/' }])).verdict,
    ).toMatchObject({ state: 'DEGRADED', rule: 'D1-inapplicable' })
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true)
  })
  it('sanitizes transport failures and never sends further requests after refusal', async () => {
    const read = vi
      .fn<typeof guardedFetch>()
      .mockRejectedValue(new Error('private credential and customer payload'))
    const result = await run(read)
    expect(result.verdict).toMatchObject({
      state: 'UNREACHABLE',
      evidence: { protocolAvailable: false },
    })
    expect(JSON.stringify(result)).not.toContain('private credential')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('rejects unsafe MCP URLs before making any request', async () => {
    const f = fixture()
    const result = await run(f.read, [
      { name: 'MCP', endpoint: 'https://user:password@provider.example/mcp' },
    ])
    expect(result.verdict).toMatchObject({
      state: 'DEGRADED',
      evidence: { errorCode: 'UNSAFE_ENDPOINT' },
    })
    expect(f.read).not.toHaveBeenCalled()
  })
  it('cannot rescue failed MCP through a canonically identical web URL', async () => {
    const f = fixture({ status: 503 })
    const read: typeof guardedFetch = async (url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json({ requestedUrl: String(url) })
        : f.read(url, init)
    const result = await run(read, [
      { name: 'MCP', endpoint: 'https://provider.example/mcp/43129' },
      { name: 'web', endpoint: 'https://PROVIDER.example:443/mcp/43129#display' },
    ])
    expect(result.verdict.state).toBe('UNREACHABLE')
    expect(result.samples).toEqual([])
  })
  it('excludes unattempted third MCP endpoints from generic fallback too', async () => {
    const f = fixture({ status: 503 })
    const read: typeof guardedFetch = async (url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json({ requestedUrl: String(url) })
        : f.read(url, init)
    const third = 'https://provider.example/mcp/43129'
    const result = await run(read, [
      ...[endpoint, `${endpoint}/2`, third].map((url) => ({ name: 'MCP', endpoint: url })),
      { name: 'web', endpoint: third },
    ])
    expect(result.verdict.state).toBe('UNREACHABLE')
    expect(result.samples).toEqual([])
    expect(f.calls).toHaveLength(2)
  })
  it('rejects an unexpanded MCP template before making any outbound request', async () => {
    const f = fixture({ reciprocal: 'match' })
    const result = await run(f.read, [
      { name: 'MCP', endpoint: 'https://provider.example/mcp/{agentId}' },
    ])
    expect(result.verdict).toMatchObject({ state: 'PLACEHOLDER_URL', rule: 'D2' })
    expect(f.read).not.toHaveBeenCalled()
  })
  it('can check a valid declared MCP alternate without requesting the placeholder', async () => {
    const f = fixture({ reciprocal: 'match' })
    const result = await run(f.read, [
      { name: 'MCP', endpoint: 'https://provider.example/mcp/{agentId}' },
      { name: 'MCP', endpoint },
    ])
    expect(result.verdict).toMatchObject({ state: 'LIVE', rule: 'MCP-D8' })
    expect(
      f.calls.filter((call) => call.method === 'POST').every((call) => call.url === endpoint),
    ).toBe(true)
  })
})
