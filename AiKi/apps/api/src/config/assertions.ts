import type { ChainConfig } from './chains.js'

export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

export interface JsonRpcClient {
  request<T>(method: string, params: unknown[]): Promise<T>
}
export interface ContractAssertion {
  label: string
  address: string
  codeBytes: number
}
export interface ChainAssertionReport {
  chainId: number
  contracts: ContractAssertion[]
  commerceImplementation: string
}

function addressFromStorage(value: string): string {
  const clean = value.startsWith('0x') ? value.slice(2) : value
  if (clean.length !== 64) throw new Error(`Unexpected EIP-1967 storage value: ${value}`)
  return `0x${clean.slice(-40)}`.toLowerCase()
}

async function assertCode(
  client: JsonRpcClient,
  label: string,
  address: string,
): Promise<ContractAssertion> {
  const code = await client.request<string>('eth_getCode', [address, 'latest'])
  if (code === '0x' || code.length <= 2)
    throw new Error(`${label} at ${address} has no deployed bytecode.`)
  return { label, address, codeBytes: (code.length - 2) / 2 }
}

/** Fail closed if an external integration changes beneath the pinned adapter. */
export async function assertChainConfiguration(
  client: JsonRpcClient,
  chain: ChainConfig,
): Promise<ChainAssertionReport> {
  const chainId = await client.request<string>('eth_chainId', [])
  if (Number(chainId) !== chain.id)
    throw new Error(`RPC returned chain ${Number(chainId)}, expected ${chain.id}.`)
  const c = chain.contracts
  const contracts = await Promise.all([
    assertCode(client, 'ERC-8004 IdentityRegistry', c.erc8004Identity),
    assertCode(client, 'ERC-8004 ReputationRegistry', c.erc8004Reputation),
    assertCode(client, 'ERC-8183 AgenticCommerce proxy', c.erc8183Commerce),
    assertCode(client, 'ERC-8183 expected implementation', c.erc8183Implementation),
    assertCode(client, 'ERC-8183 EvaluatorRouter', c.erc8183EvaluatorRouter),
    assertCode(client, '$U settlement token', c.settlementToken),
    assertCode(client, 'Altana KeyStore', c.altanaKeyStore),
    assertCode(client, 'Altana KeyStoreController', c.altanaKeyStoreController),
    assertCode(client, 'DelegationManager', c.delegationManager),
    assertCode(client, 'EIP-7702 delegation implementation', c.delegationImplementation),
  ])
  const raw = await client.request<string>('eth_getStorageAt', [
    c.erc8183Commerce,
    EIP1967_IMPLEMENTATION_SLOT,
    'latest',
  ])
  const commerceImplementation = addressFromStorage(raw)
  if (commerceImplementation !== c.erc8183Implementation.toLowerCase()) {
    throw new Error(
      `ERC-8183 implementation changed: expected ${c.erc8183Implementation}, got ${commerceImplementation}. Disable commerce until adapter review.`,
    )
  }
  return { chainId: chain.id, contracts, commerceImplementation }
}
