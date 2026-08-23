import { describe, expect, it } from 'vitest'
import { assertChainConfiguration, EIP1967_IMPLEMENTATION_SLOT, type JsonRpcClient } from './assertions.js'
import { BSC_MAINNET } from './chains.js'

const code = '0x60006000'
const stableRpc: JsonRpcClient = { async request<T>(method: string): Promise<T> {
  if (method === 'eth_chainId') return '0x38' as T
  if (method === 'eth_getCode') return code as T
  if (method === 'eth_getStorageAt') return `0x${'00'.repeat(12)}${BSC_MAINNET.contracts.erc8183Implementation.slice(2)}` as T
  throw new Error(`Unexpected ${method}`)
} }

describe('assertChainConfiguration', () => {
  it('accepts the pinned BSC deployment set', async () => {
    const report = await assertChainConfiguration(stableRpc, BSC_MAINNET)
    expect(report.chainId).toBe(56)
    expect(report.contracts).toHaveLength(10)
    expect(report.commerceImplementation).toBe(BSC_MAINNET.contracts.erc8183Implementation.toLowerCase())
  })
  it('fails closed when the commerce implementation changes', async () => {
    const changed: JsonRpcClient = { async request<T>(method: string): Promise<T> {
      if (method === 'eth_chainId') return '0x38' as T
      if (method === 'eth_getCode') return code as T
      if (method === 'eth_getStorageAt') return `0x${'00'.repeat(12)}${'11'.repeat(20)}` as T
      throw new Error(`Unexpected ${method}`)
    } }
    await expect(assertChainConfiguration(changed, BSC_MAINNET)).rejects.toThrow('implementation changed')
  })
  it('pins the standard EIP-1967 slot', () => expect(EIP1967_IMPLEMENTATION_SLOT).toHaveLength(66))
})
