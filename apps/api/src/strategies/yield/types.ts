export type YieldVenueId = 'idle' | 'venus' | 'aave'
export type YieldAddress = `0x${string}`
export type YieldHash = `0x${string}`

export interface YieldBlock {
  chainId: 56
  number: bigint
  hash: YieldHash
  timestamp: number
  finalized: true
  canonical: true
}

/** Exact immutable onchain limits, all amounts in canonical USDT's 18-decimal units. */
export interface YieldVaultLimits {
  maxPrincipal: bigint
  maxMove: bigint
  maxTurnover: bigint
  minIdle: bigint
  maxVenusExposure: bigint
  maxAaveExposure: bigint
  maxLossPerMove: bigint
  maxCumulativeLoss: bigint
  maxLossBps: number
}

/** A reviewed model resolver must establish the model address/hash and its clock.
 * A numerically plausible rate is not proof that an unknown model is supported. */
export type YieldRateClock =
  | { kind: 'annual'; scale: bigint }
  | { kind: 'per-second'; scale: bigint; verifiedOnchain: true }
  | {
      kind: 'per-block'
      scale: bigint
      verifiedOnchain: true
      sampleStartBlock: bigint
      sampleStartTimestamp: number
    }

interface YieldModelIdentity {
  address: YieldAddress
  runtimeHash: YieldHash
  verified: true
  clock: YieldRateClock
}

export interface YieldTwoSlopeModel extends YieldModelIdentity {
  kind: 'reviewed-two-slope' | 'aave-v3-two-slope'
  /** Native clock/scale units. Slopes are increments at the kink and at full utilization. */
  baseBorrowRate: bigint
  slopeBelowKink: bigint
  slopeAboveKink: bigint
  kinkWad: bigint
}

export interface YieldVenusTwoKinksModel extends YieldModelIdentity {
  kind: 'venus-two-kinks'
  implementation: YieldAddress
  implementationHash: YieldHash
  baseBorrowRate: bigint
  multiplierPerBlock: bigint
  kink1Wad: bigint
  multiplier2PerBlock: bigint
  baseRate2PerBlock: bigint
  kink2Wad: bigint
  jumpMultiplierPerBlock: bigint
  rate1: bigint
  rate2: bigint
  /** Model parameter only, NEVER used as a guessed actual chain clock. */
  blocksPerYear: bigint
}

export type YieldRateModel = YieldTwoSlopeModel | YieldVenusTwoKinksModel

export interface YieldVenueSnapshot {
  id: 'venus' | 'aave'
  blockNumber: bigint
  blockHash: YieldHash
  identityVerified: true
  underlying: YieldAddress
  market: YieldAddress
  receipt: YieldAddress
  decimals: 18
  listed: boolean
  active: boolean
  supplyPaused: boolean
  withdrawPaused: boolean
  frozen: boolean
  legacy: boolean
  /** Includes debt, excludes reserves for Venus. Aave unbacked/stable-debt configurations
   * are unsupported in this version and must never be silently approximated. */
  cash: bigint
  virtualCash: bigint
  debt: bigint
  reserves: bigint
  unbacked: bigint
  stableDebt: bigint
  reserveFactorWad: bigint
  totalSupplied: bigint
  accruedTreasuryAssets: bigint
  /** Raw USDT units. null is an explicitly verified unlimited Aave supply cap. */
  supplyCap: bigint | null
  /** The verified current source fee, not an agent-selected estimate. */
  withdrawalFeeWad: bigint
  receiptRate: bigint
  actualReceiptBalance: bigint
  observedSupplyRate: bigint
  model: YieldRateModel | null
}

/** A quote of the COMPLETE manager/delegation transaction, not only the inner vault call.
 * Must be refreshed for these exact source/destination/amount/nonce/block values. */
export interface YieldExecutionQuote {
  vault: YieldAddress
  policyHash: YieldHash
  blockNumber: bigint
  blockHash: YieldHash
  nonce: bigint
  source: YieldVenueId
  destination: YieldVenueId
  assets: bigint
  minReceived: bigint
  deadline: number
  path: 'manager-delegation'
  simulated: true
  gasUnits: bigint
  gasPriceWei: bigint
  /** Conservative future unwind allowance; included even if the relayer pays today's gas. */
  unwindGasUnits: bigint
}

export interface YieldSnapshot {
  block: YieldBlock
  vault: YieldAddress
  controller: YieldAddress
  policyHash: YieldHash
  identityVerified: true
  expiresAt: number
  minInterval: number
  maxDeadlineDelay: number
  limits: YieldVaultLimits
  nonce: bigint
  lastExecutionAt: number
  paused: boolean
  fundedPrincipal: bigint
  turnover: bigint
  cumulativeLoss: bigint
  managedIdle: bigint
  actualIdle: bigint
  managedVenusShares: bigint
  managedAaveScaled: bigint
  venues: { venus: YieldVenueSnapshot; aave: YieldVenueSnapshot }
  /** USDT units per native BNB, in ray precision. Must come from reviewed, fresh prices
   * for BOTH assets; this is not a hardcoded assumption that USDT equals one dollar. */
  nativePrice: {
    blockNumber: bigint
    blockHash: YieldHash
    usdtPerBnbRay: bigint
    updatedAt: number
    verified: true
  } | null
  executionQuotes: YieldExecutionQuote[]
}

/** Planner-only conservative limits cannot weaken the immutable vault policy. */
export interface YieldPlannerPolicy {
  vault: YieldAddress
  controller: YieldAddress
  policyHash: YieldHash
  limits: YieldVaultLimits
  horizonSeconds: number
  maxSnapshotAgeSeconds: number
  maxPriceAgeSeconds: number
  minClockSampleSeconds: number
  maxObservationGapSeconds: number
  requiredObservations: number
  minObservationSeconds: number
  minMove: bigint
  minIncrementalYield: bigint
  minNetGain: bigint
  maxGasCost: bigint
  gasBufferBps: number
  capacityBuffer: bigint
  liquidityBuffer: bigint
  minIdleBps: number
  rateToleranceRay: bigint
  /** Reviewed registry pins. Unknown proxy/model implementations fail closed. */
  reviewedModels: { address: YieldAddress; runtimeHash: YieldHash }[]
}

export interface YieldPlannerState {
  pendingNonce?: bigint
  lastObservation?: {
    blockNumber: bigint
    blockHash: YieldHash
    timestamp: number
    candidate: string
    count: number
    nonce: bigint
  }
}

export interface YieldCandidate {
  source: YieldVenueId
  destination: YieldVenueId
  assets: bigint
  expectedMoved: bigint
  expectedLoss: bigint
  incrementalYield: bigint
  /** The reviewed horizon, capped by the immutable authority's remaining lifetime. */
  horizonSeconds: number
  reserveRestoration: boolean
}

export interface YieldPlan extends YieldCandidate {
  vault: YieldAddress
  policyHash: YieldHash
  expectedNonce: bigint
  quoteBlockNumber: bigint
  quoteBlockHash: YieldHash
  minReceived: bigint
  deadline: number
  gasCost: bigint
  netGain: bigint
}

export type YieldReason =
  | 'INVALID_INPUT'
  | 'IDENTITY_MISMATCH'
  | 'STALE_SNAPSHOT'
  | 'INCONSISTENT_SNAPSHOT'
  | 'PAUSED'
  | 'EXPIRED'
  | 'PENDING_EXECUTION'
  | 'COOLDOWN'
  | 'RATE_MODEL_UNSUPPORTED'
  | 'RATE_MISMATCH'
  | 'NO_CAPACITY'
  | 'RESERVE_UNAVAILABLE'
  | 'NO_NET_BENEFIT'
  | 'QUOTE_REQUIRED'
  | 'PRICE_UNAVAILABLE'
  | 'GAS_LIMIT'
  | 'HYSTERESIS'
  | 'READY'

export type YieldDecision =
  | {
      act: false
      code: YieldReason
      reason: string
      nextState: YieldPlannerState
      candidates?: YieldCandidate[]
    }
  | { act: true; code: 'READY'; reason: string; nextState: YieldPlannerState; plan: YieldPlan }
