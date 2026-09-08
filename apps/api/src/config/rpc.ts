import type { JsonRpcClient } from './assertions.js'

export function createRpcClient(url: string): JsonRpcClient {
  return {
    async request<T>(method: string, params: unknown[]): Promise<T> {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!response.ok) throw new Error(`${method}: RPC returned HTTP ${response.status}`)
      const body = (await response.json()) as { result?: T; error?: { message?: string } }
      if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`)
      if (body.result === undefined) throw new Error(`${method}: RPC response had no result`)
      return body.result
    },
  }
}
