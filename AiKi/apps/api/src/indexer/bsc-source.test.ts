import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBscRegistrySource } from './bsc-source.js'

afterEach(() => vi.unstubAllGlobals())

describe('BSC registry source', () => {
  it('uses finalized head and preserves BSC milliTimestamp precision', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body)) as { method: string }
      const result = method === 'eth_getBlockByNumber'
        ? { number: '0x64', timestamp: '0x1', milliTimestamp: '1724155200123' }
        : '0x64'
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
    }))
    const source = createBscRegistrySource({ url: 'https://rpc.example.test', maxSpan: 1 })
    expect(await source.finalizedBlockNumber()).toBe(100)
    expect(await source.blockTimestamp(100)).toBe('2024-08-20T12:00:00.123Z')
  })
})
