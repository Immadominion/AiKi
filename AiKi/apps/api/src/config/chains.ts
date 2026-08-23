/** Addresses are always keyed by chain ID; never promote them to global constants. */
export interface ChainContracts {
  erc8004Identity: `0x${string}`
  erc8004Reputation: `0x${string}`
  erc8183Commerce: `0x${string}`
  erc8183Implementation: `0x${string}`
  erc8183EvaluatorRouter: `0x${string}`
  settlementToken: `0x${string}`
  altanaKeyStore: `0x${string}`
  altanaKeyStoreController: `0x${string}`
  delegationManager: `0x${string}`
  delegationImplementation: `0x${string}`
  venusComptroller: `0x${string}`
  pancakeV3Factory: `0x${string}`
  pancakeV3PositionManager: `0x${string}`
}

export interface ChainConfig {
  id: number
  name: string
  nativeCurrency: 'BNB'
  finalityTag: 'finalized'
  expectedReorgDepth: number
  contracts: ChainContracts
}

export const BSC_MAINNET: ChainConfig = {
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: 'BNB',
  finalityTag: 'finalized',
  expectedReorgDepth: 8,
  contracts: {
    erc8004Identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    erc8004Reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    erc8183Commerce: '0xEa4DAa3100A767e86FDed867729ae7446476EBA6',
    erc8183Implementation: '0xd5f9b570c96b5d67702d508c0bfb8b3b09209787',
    erc8183EvaluatorRouter: '0x51895229E12F9876011789B04f8698af06cCD6DA',
    settlementToken: '0xcE24439F2D9C6a2289F741120FE202248B666666',
    altanaKeyStore: '0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a',
    altanaKeyStoreController: '0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555',
    delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    delegationImplementation: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
    venusComptroller: '0xfD36E2c2a6789Db23113685031d7F16329158384',
    pancakeV3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    pancakeV3PositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  },
}

export const CHAINS: ReadonlyMap<number, ChainConfig> = new Map([[BSC_MAINNET.id, BSC_MAINNET]])

export function chainFor(id: number): ChainConfig {
  const chain = CHAINS.get(id)
  if (!chain) throw new Error(`Unsupported chain ${id}. Addresses must be configured per chain.`)
  return chain
}
