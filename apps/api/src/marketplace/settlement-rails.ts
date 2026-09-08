import { BSC_MAINNET } from '../config/chains.js'
import { MarketplaceError } from './errors.js'

export type SettlementRail = Readonly<{
  rail: 'BNB_APEX_ERC8183'
  version: '2026-09-03'
  chainId: number
  contract: `0x${string}`
  token: `0x${string}`
  decimals: number
  finality: {
    tag: 'finalized'
    expectedReorgDepth: number
  }
}>

const lowerAddress = (value: `0x${string}`): `0x${string}` => value.toLowerCase() as `0x${string}`

const BSC_APEX_RAIL: SettlementRail = {
  rail: 'BNB_APEX_ERC8183',
  version: '2026-09-03',
  chainId: BSC_MAINNET.id,
  contract: lowerAddress(BSC_MAINNET.contracts.erc8183Commerce),
  token: lowerAddress(BSC_MAINNET.contracts.settlementToken),
  decimals: 18,
  finality: {
    tag: BSC_MAINNET.finalityTag,
    expectedReorgDepth: BSC_MAINNET.expectedReorgDepth,
  },
}

export function settlementRailFor(input: {
  chainId: number
  token: `0x${string}`
  decimals: number
}): SettlementRail {
  const token = lowerAddress(input.token)
  if (
    input.chainId !== BSC_APEX_RAIL.chainId ||
    token !== BSC_APEX_RAIL.token ||
    input.decimals !== BSC_APEX_RAIL.decimals
  ) {
    throw new MarketplaceError(
      'SETTLEMENT_RAIL_UNSUPPORTED',
      'This offer cannot be funded because its settlement asset is not enabled.',
      {
        statusCode: 409,
        details: {
          chainId: String(input.chainId),
          token,
          decimals: String(input.decimals),
        },
      },
    )
  }
  return BSC_APEX_RAIL
}
