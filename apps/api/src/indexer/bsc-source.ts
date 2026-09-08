import { BSC_MAINNET } from '../config/chains.js'
import { blockNumber, indexRegistry, type RpcConfig } from './registry.js'
import type { RegistrySource } from './runner.js'

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const payload = (await response.json()) as { result?: T; error?: { message?: string } }
  if (!response.ok || payload.error || payload.result === undefined)
    throw new Error(`${method}: ${payload.error?.message ?? `HTTP ${response.status}`}`)
  return payload.result
}

function rpcNumber(value: string): number {
  return value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value)
}

/** Source adapter that preserves BSC's milliTimestamp instead of silently discarding it. */
export function createBscRegistrySource(config: RpcConfig): RegistrySource {
  return {
    finalizedBlockNumber: () => blockNumber(config.url, BSC_MAINNET.finalityTag),
    async blockTimestamp(block: number): Promise<string> {
      const result = await rpc<{ milliTimestamp?: string; timestamp: string }>(
        config.url,
        'eth_getBlockByNumber',
        [`0x${block.toString(16)}`, false],
      )
      const milliseconds = result.milliTimestamp
        ? rpcNumber(result.milliTimestamp)
        : rpcNumber(result.timestamp) * 1000
      return new Date(milliseconds).toISOString()
    },
    registered: (fromBlock: number) => indexRegistry(config, fromBlock),
  }
}
