import { type Address, createPublicClient, http, type PublicClient, parseAbi } from 'viem'
import { bsc } from 'viem/chains'
import { BSC_MAINNET } from '../../config/chains.js'
import type { PancakePositionSnapshot, PancakeRebalanceAssessment } from './types.js'

const managerAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
])
const factoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
])
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
])

export function assessPancakePosition(
  snapshot: PancakePositionSnapshot,
): PancakeRebalanceAssessment {
  const empty = snapshot.liquidity === '0'
  const state = empty
    ? 'EMPTY_LIQUIDITY'
    : snapshot.currentTick < snapshot.tickLower
      ? 'BELOW_RANGE'
      : snapshot.currentTick >= snapshot.tickUpper
        ? 'ABOVE_RANGE'
        : 'IN_RANGE'
  const distanceToRangeTicks =
    state === 'BELOW_RANGE'
      ? snapshot.tickLower - snapshot.currentTick
      : state === 'ABOVE_RANGE'
        ? snapshot.currentTick - snapshot.tickUpper + 1
        : 0
  const recommendation =
    state === 'IN_RANGE'
      ? 'HOLD'
      : state === 'BELOW_RANGE'
        ? 'REBALANCE_UPWARD'
        : state === 'ABOVE_RANGE'
          ? 'REBALANCE_DOWNWARD'
          : 'NO_ACTION'
  return {
    ...snapshot,
    category: 'rebalancing',
    assessmentVersion: 'pancake-v3-rebalance/v1',
    state,
    recommendation,
    distanceToRangeTicks,
    methodology:
      'PancakeSwap v3 position NFT ticks are compared directly with the pool slot0 current tick. The direction names describe the required range relocation, not a trade recommendation.',
    caveats: [
      'Read-only assessment: no collect, decreaseLiquidity, swap, or mint transaction is initiated.',
      'tokensOwed values are uncollected amounts reported by the position manager; they are not an APR or realised-fee estimate.',
    ],
  }
}

export interface PancakeReader {
  assess(tokenId: string): Promise<PancakeRebalanceAssessment>
}
export class PancakeV3Client implements PancakeReader {
  private readonly client: PublicClient
  constructor(rpcUrl: string, client?: PublicClient) {
    this.client = client ?? createPublicClient({ chain: bsc, transport: http(rpcUrl) })
  }
  async assess(tokenId: string): Promise<PancakeRebalanceAssessment> {
    if (!/^\d+$/.test(tokenId)) throw new Error('tokenId must be a non-negative integer.')
    const manager = BSC_MAINNET.contracts.pancakeV3PositionManager as Address
    const [rawPosition, ownerRaw] = await Promise.all([
      this.client.readContract({
        address: manager,
        abi: managerAbi,
        functionName: 'positions',
        args: [BigInt(tokenId)],
      }),
      this.client.readContract({
        address: manager,
        abi: managerAbi,
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      }),
    ])
    const position = rawPosition as readonly [
      bigint,
      Address,
      Address,
      Address,
      number,
      number,
      number,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ]
    const owner = ownerRaw as Address
    const factory = BSC_MAINNET.contracts.pancakeV3Factory as Address
    const poolRaw = await this.client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [position[2], position[3], position[4]],
    })
    const pool = poolRaw as Address
    if (pool === '0x0000000000000000000000000000000000000000')
      throw new Error('PancakeSwap factory returned no pool for this position.')
    const slot0Raw = await this.client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'slot0',
    })
    const slot0 = slot0Raw as readonly [bigint, number, number, number, number, number, boolean]
    return assessPancakePosition({
      tokenId,
      owner,
      token0: position[2],
      token1: position[3],
      fee: position[4],
      tickLower: position[5],
      tickUpper: position[6],
      liquidity: position[7].toString(),
      tokensOwed0: position[10].toString(),
      tokensOwed1: position[11].toString(),
      currentTick: slot0[1],
      pool,
      observedAt: new Date().toISOString(),
    })
  }
}
