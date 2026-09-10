import type { DELEGATION_TYPES, UnsignedDelegation } from '../delegation.js'
import type { StrategyBinding, StrategyKind } from './index.js'
import type {
  PreparedStrategyDeployment,
  StrategyAddress,
  StrategyHash,
  StrategySetupInput,
  StrategyUnsignedTransaction,
} from './setup.js'

export type StrategyAgentMap = Partial<
  Record<StrategyKind, { agentId: string; registry: StrategyAddress; chainId: 56 }>
>
export type StrategyPublicConfig = { agents?: StrategyAgentMap } & (
  | { available: false; chainId: 56; reason: string }
  | {
      available: true
      chainId: 56
      configurationHash: StrategyHash
      manager: StrategyAddress
      executor: StrategyAddress
      bindingEnforcer: StrategyAddress
      expiryEnforcer: StrategyAddress
      kinds: StrategyKind[]
      factories: Partial<
        Record<StrategyKind, { address: StrategyAddress; runtimeCodeHash: StrategyHash }>
      >
      schedulerReady: boolean
    }
)

export type StrategyWalletActionRequest =
  | { kind: 'fund'; assets: string }
  | { kind: 'fund'; rungIndex: number; amount0: string; amount1: string }
  | { kind: 'enroll'; tokenId: string }
  | { kind: 'resume' | 'pause' }
  | { kind: 'withdraw'; token: StrategyAddress; amount: string }
  | { kind: 'withdraw'; rungIndex: number; amount0: string; amount1: string }
  | { kind: 'withdraw' }

export interface StrategyWalletAction {
  id: string
  kind:
    | 'deploy'
    | 'approve_reset'
    | 'approve'
    | 'fund'
    | 'approve_nft'
    | 'enroll'
    | 'resume'
    | 'pause'
    | 'withdraw'
  status: 'PREPARED' | 'SUBMITTED' | 'FINALIZED' | 'REVERTED' | 'NEEDS_REVIEW'
  transaction: StrategyUnsignedTransaction
  review: {
    summary: string
    assets?: { token: StrategyAddress; amount: string; decimals: number }[]
    rungIndex?: number
    tokenId?: string
    recipient?: StrategyAddress
  }
  transactionHash: StrategyHash | null
}

export interface StrategyAuthorizationReview {
  owner: StrategyAddress
  manager: StrategyAddress
  executor: StrategyAddress
  binding: StrategyBinding
  input: StrategySetupInput
  expiresAt: string
  gasLimitWei: string
  /** Server-reviewed defaults. JSON-safe raw-unit decimal strings, never caller callbacks. */
  plannerPolicy: unknown
  summary: string
}
export interface StrategyAuthorizationPreparation {
  setupId: string
  review: StrategyAuthorizationReview
  unsigned: UnsignedDelegation
  domain: { name: string; version: string; chainId: 56; verifyingContract: StrategyAddress }
  types: typeof DELEGATION_TYPES
  primaryType: 'Delegation'
  message: {
    delegate: StrategyAddress
    delegator: StrategyAddress
    authority: StrategyHash
    caveats: { enforcer: StrategyAddress; terms: StrategyHash }[]
    salt: string
    epoch: string
  }
  digest: StrategyHash
}
export interface StrategySetupView {
  id: string
  owner: StrategyAddress
  chainId: 56
  kind: StrategyKind
  input: StrategySetupInput
  gasLimitWei: string
  prepared: PreparedStrategyDeployment
  binding: StrategyBinding | null
  status: 'DRAFT' | 'DEPLOYED' | 'SIGNED' | 'ACTIVE' | 'PAUSED' | 'NEEDS_REVIEW'
  revision: string
  actions: StrategyWalletAction[]
  authorization: null | {
    id: string
    jobId: string
    watchId: string
    signedAt: string
    review: StrategyAuthorizationReview
    unsigned?: UnsignedDelegation
    digest?: StrategyHash
  }
  readiness: { ready: boolean; reasons: string[]; schedulerReady: boolean }
  watch?: {
    status: 'PAUSED' | 'ACTIVE' | 'NEEDS_REVIEW' | 'CLOSED'
    nextRunAt: string
    lastDecision: { code: string | null; reason: string; at: string } | null
    lastTransactionHash: StrategyHash | null
  }
}
