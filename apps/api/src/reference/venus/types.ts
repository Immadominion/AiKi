export const WAD = 10n ** 18n

export interface VenusMarketSnapshot {
  vToken: `0x${string}`
  collateralFactor: bigint
  /**
   * The ratio Venus actually liquidates at, which is not always the ratio it
   * lends at. Venus's Comptroller keeps both, and `getAccountLiquidity` answers
   * with this one.
   */
  liquidationThreshold: bigint
  vTokenBalance: bigint
  borrowBalance: bigint
  exchangeRate: bigint
  underlyingPrice: bigint
}

export interface VenusAccountSnapshot {
  account: `0x${string}`
  observedAt: string
  controllerLiquidity: bigint
  controllerShortfall: bigint
  markets: VenusMarketSnapshot[]
}

export type HealthStatus =
  | 'NO_POSITION'
  | 'NO_DEBT'
  | 'SAFE'
  | 'AT_RISK'
  | 'LIQUIDATABLE'
  | 'INCONSISTENT'

export interface Amount {
  amount: string
  asset: 'USD'
  decimals: 18
}

export interface VenusPosition {
  vToken: `0x${string}`
  collateralFactor: string
  liquidationThreshold: string
  supplied: Amount
  borrowed: Amount
  adjustedCollateral: Amount
}

export interface VenusHealthAssessment {
  account: `0x${string}`
  protocol: 'Venus'
  category: 'health_factor'
  assessmentVersion: 'venus-health/v1'
  observedAt: string
  status: HealthStatus
  minimumHealthFactor: string
  healthFactor?: string
  supplied: Amount
  adjustedCollateral: Amount
  borrowed: Amount
  controllerLiquidity: Amount
  controllerShortfall: Amount
  positions: VenusPosition[]
  methodology: string
  consistency: { verified: boolean; detail: string }
  caveats: string[]
}
