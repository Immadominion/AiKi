import type { StrategyBinding, StrategyKind } from './index.js'

export type StrategyAddress = `0x${string}`
export type StrategyHash = `0x${string}`
/** Decimal strings are canonical unsigned integers in RAW token units; never floats. */
export interface StrategyCommonPolicyInput {
  expiresAt: string
  minInterval: number
  maxDeadlineDelay: number
}
export interface YieldSetupPolicy {
  maxPrincipal: string
  maxMove: string
  maxTurnover: string
  minIdle: string
  maxVenusExposure: string
  maxAaveExposure: string
  maxLossPerMove: string
  maxCumulativeLoss: string
  maxLossBps: number
}
export interface GridSetupPolicy {
  tickLower: number
  tickUpper: number
  maxInput0: string
  maxInput1: string
  fundingCap0: string
  fundingCap1: string
  turnoverCap0: string
  turnoverCap1: string
  twapWindow: number
  maxDeviationTicks: number
  minLiquidity: string
  maxSlippageBps: number
  minFillBps: number
  minCycleGainBps: number
  hysteresisTicks: number
}
export interface GridSetupRung {
  buyTick: number
  sellTick: number
  lot0: string
  lot1: string
  initialSell: boolean
}
export interface LPSetupPolicy {
  twapWindow: number
  maxDeviationTicks: number
  minPoolLiquidity: string
  rangeWidth: number
  maxCenterOffsetTicks: number
  maxSwapSlippageBps: number
  maxLiquiditySlippageBps: number
  minSwapFillBps: number
  minDeployedBps: number
  maxLossBps: number
  maxSwap0: string
  maxSwap1: string
  maxPositionValueQuote: string
  maxLossQuote: string
  maxCumulativeLossQuote: string
}
export type StrategySetupInput = {
  version: 1
  chainId: 56
  controller: StrategyAddress
  common: StrategyCommonPolicyInput
} & (
  | { kind: 'yield'; policy: YieldSetupPolicy }
  | { kind: 'grid'; policy: GridSetupPolicy; rungs: GridSetupRung[] }
  | { kind: 'lp'; policy: LPSetupPolicy }
)
export interface StrategyUnsignedTransaction {
  chainId: 56
  from: StrategyAddress
  to: StrategyAddress
  data: StrategyHash
  value: '0'
}
export interface StrategyFinalizedBlock {
  number: string
  hash: StrategyHash
  timestamp: string
}
/** Persist this entire canonical preparation, not only its predicted address. It has no key,
 * signature, transaction nonce or gas fee. Only the owner wallet may decide to send it. */
export interface PreparedStrategyDeployment {
  version: 1
  chainId: 56
  kind: StrategyKind
  owner: StrategyAddress
  controller: StrategyAddress
  input: StrategySetupInput
  requestDigest: StrategyHash
  configurationDigest: StrategyHash
  policyHash: StrategyHash
  predictedVault: StrategyAddress
  block: StrategyFinalizedBlock
  unsignedTransaction: StrategyUnsignedTransaction
  alreadyDeployed: boolean
}
export type StrategyDeploymentPreparation =
  | { status: 'prepared'; prepared: PreparedStrategyDeployment }
  | { status: 'blocked'; reason: string }
export type StrategyDeploymentFinalization =
  | {
      status: 'verified'
      binding: StrategyBinding
      owner: StrategyAddress
      requestDigest: StrategyHash
      transactionHash: StrategyHash
      block: StrategyFinalizedBlock
      retry: boolean
    }
  | { status: 'pending' | 'blocked'; reason: string }
