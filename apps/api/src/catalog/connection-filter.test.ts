import { describe, expect, it, vi } from 'vitest'
import { CatalogService } from './service.js'
import type { CatalogFetch } from './transport.js'

const registration = (id: string, services: Record<string, unknown> = {}) => ({
  token_id: id,
  chain_id: 56,
  contract_address: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  name: `Registered agent ${id}`,
  supported_protocols: ['MCP', 'A2A'],
  services,
})

describe('catalog connection filters', () => {
  it.each(['MCP', 'A2A'] as const)(
    'asks the source for a published %s endpoint without discarding summary-only rows',
    async (protocol) => {
      const key = protocol.toLowerCase()
      const fetcher = vi.fn<CatalogFetch>(async () =>
        Response.json({
          items: [
            registration('1'),
            registration('2', { [key]: { endpoint: 'file:///private/service' } }),
            registration('3', { [key]: { endpoint: 'https://provider.example/service' } }),
            registration('4', {
              [protocol === 'MCP' ? 'a2a' : 'mcp']: {
                endpoint: 'https://provider.example/other-service',
              },
            }),
          ],
          total: 20,
          has_more: true,
          next_cursor: 'source_cursor',
        }),
      )
      const page = await new CatalogService({ fetcher }).list({ protocol })
      const url = fetcher.mock.calls[0]?.[0]
      expect(url?.searchParams.get('supported_protocol')).toBe(protocol)
      expect(url?.searchParams.get(`has_${key}`)).toBe('true')
      expect(url?.searchParams.get('chain_id')).toBe('56')
      // The live list response omits endpoint addresses, even when has_mcp or
      // has_a2a matched. Availability is checked using the detail endpoint later.
      expect(page.items.map((agent) => agent.id)).toEqual(['1', '2', '3', '4'])
      expect(page.items[0]?.taskAvailability).toBe('not_verified')
      expect(page.items[0]?.connector).toBe('discovery_only')
      expect(page.countMeaning).toBe('registered_agents_not_verified_working')
      expect(page.nextCursor).toBe('source_cursor')
      expect(page.hasMore).toBe(true)
      // Source totals remain source totals, not a fabricated working-agent count.
      expect(page.totalRegistered).toBe(20)
    },
  )

  it('keeps identities without public endpoints browsable without a connection filter', async () => {
    const fetcher = vi.fn<CatalogFetch>(async () =>
      Response.json({ items: [registration('1')], total: 1, has_more: false }),
    )
    const page = await new CatalogService({ fetcher }).list({})
    const url = fetcher.mock.calls[0]?.[0]
    expect(url?.searchParams.has('has_mcp')).toBe(false)
    expect(url?.searchParams.has('has_a2a')).toBe(false)
    expect(page.items[0]?.id).toBe('1')
    expect(page.items[0]?.services).toEqual([])
  })

  it('preserves summary rows and pagination when endpoint details are omitted by the list API', async () => {
    const fetcher = vi.fn<CatalogFetch>(async () =>
      Response.json({
        items: [registration('1')],
        total: 2,
        has_more: true,
        next_cursor: 'next_page',
      }),
    )
    const page = await new CatalogService({ fetcher }).list({ protocol: 'MCP' })
    expect(page.items.map((agent) => agent.id)).toEqual(['1'])
    expect(page.nextCursor).toBe('next_page')
    expect(page.hasMore).toBe(true)
  })
})
