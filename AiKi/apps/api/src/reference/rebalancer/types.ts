export interface PancakePositionSnapshot {
  tokenId: string
  owner: `0x${string}`
  token0: `0x${string}`
  token1: `0x${string}`
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: string
  tokensOwed0: string
  tokensOwed1: string
  currentTick: number
  pool: `0x${string}`
  observedAt: string
}

export type RebalanceState = 'IN_RANGE' | 'BELOW_RANGE' | 'ABOVE_RANGE' | 'EMPTY_LIQUIDITY'
export type RebalanceRecommendation = 'HOLD' | 'REBALANCE_UPWARD' | 'REBALANCE_DOWNWARD' | 'NO_ACTION'

export interface PancakeRebalanceAssessment extends PancakePositionSnapshot {
  category: 'rebalancing'
  assessmentVersion: 'pancake-v3-rebalance/v1'
  state: RebalanceState
  recommendation: RebalanceRecommendation
  distanceToRangeTicks: number
  methodology: string
  caveats: string[]
}
