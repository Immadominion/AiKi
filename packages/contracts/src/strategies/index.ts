export { GridStrategyVaultAbi } from './GridStrategyVault.js'
export { PancakeLPVaultAbi } from './PancakeLPVault.js'
export { YieldAllocationVaultAbi } from './YieldAllocationVault.js'

export type StrategyKind = 'yield' | 'grid' | 'lp'

/** Wire values are decimal strings, never floating point amounts or mixed token totals. */
export interface StrategyBinding {
  version: 1
  chainId: 56
  kind: StrategyKind
  vault: `0x${string}`
  controller: `0x${string}`
  policyHash: `0x${string}`
  runtimeCodeHash: `0x${string}`
}

export type StrategyLifecycle =
  | 'needs_deployment'
  | 'needs_funding'
  | 'needs_signature'
  | 'ready'
  | 'active'
  | 'paused'
  | 'needs_review'
  | 'expired'
  | 'closed'
