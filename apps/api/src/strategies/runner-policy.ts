import type { Hex } from 'viem'
import type { GridPlannerPolicy } from './grid-planner.js'
import type { LPPlannerPolicy } from './lp-planner.js'
import { nonzeroHash } from './operation.js'
import { isVerifiedStrategySnapshot, type VerifiedStrategySnapshot } from './snapshot.js'
import { CANONICAL_YIELD_MODEL_PINS } from './yield/mainnet-resolvers.js'
import type { YieldPlannerPolicy } from './yield/types.js'

export type StrategyRunnerPolicy =
  | { version: 1; kind: 'yield'; intervalSeconds: 60; planner: YieldPlannerPolicy }
  | { version: 1; kind: 'grid'; intervalSeconds: 30; planner: GridPlannerPolicy }
  | { version: 1; kind: 'lp'; intervalSeconds: 60; planner: LPPlannerPolicy }

export interface StrategyRunnerPins {
  poolRuntimeCodeHash?: Hex
}
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const WAD = 10n ** 18n

/** Versioned service policy, displayed before signing. Cannot loosen immutable vault limits. */
export function createStrategyRunnerPolicy(
  snapshot: VerifiedStrategySnapshot,
  gasLimitWei: bigint,
  pins: StrategyRunnerPins = {},
): StrategyRunnerPolicy {
  if (
    !isVerifiedStrategySnapshot(snapshot) ||
    typeof gasLimitWei !== 'bigint' ||
    gasLimitWei <= 0n ||
    gasLimitWei > 10n ** 15n
  )
    throw new Error('A verified vault and an execution gas ceiling up to 0.001 BNB are required.')
  const state = snapshot.state
  if (state.kind === 'yield')
    return {
      version: 1,
      kind: 'yield',
      intervalSeconds: 60,
      planner: {
        vault: snapshot.binding.vault,
        controller: snapshot.binding.controller,
        policyHash: snapshot.binding.policyHash,
        limits: { ...state.limits },
        horizonSeconds: 30 * 86400,
        maxSnapshotAgeSeconds: 30,
        maxPriceAgeSeconds: 930,
        minClockSampleSeconds: 300,
        maxObservationGapSeconds: 900,
        requiredObservations: 2,
        minObservationSeconds: 60,
        minMove: min(WAD, state.limits.maxMove),
        minIncrementalYield: 10n ** 14n,
        minNetGain: 10n ** 14n,
        maxGasCost: WAD,
        gasBufferBps: 2500,
        capacityBuffer: 0n,
        liquidityBuffer: 0n,
        minIdleBps: 0,
        rateToleranceRay: 10n ** 18n,
        reviewedModels: CANONICAL_YIELD_MODEL_PINS.map((pin) => ({ ...pin })),
      },
    }
  if (state.kind === 'grid')
    return {
      version: 1,
      kind: 'grid',
      intervalSeconds: 30,
      planner: {
        maxSnapshotAgeSeconds: 30,
        deadlineSeconds: 90,
        maxGasUnits: 3_000_000n,
        maxGasPriceWei: 1_000_000_000n,
        maxGasCostWei: gasLimitWei,
        gasBufferBps: 2500,
      },
    }
  if (!nonzeroHash(pins.poolRuntimeCodeHash))
    throw new Error('The LP pool must have a reviewed runtime code pin.')
  return {
    version: 1,
    kind: 'lp',
    intervalSeconds: 60,
    planner: {
      poolRuntimeCodeHash: pins.poolRuntimeCodeHash.toLowerCase() as Hex,
      maxSnapshotAgeSeconds: 30,
      triggerEdgeTicks: Math.max(
        1,
        Math.min(state.protocol.tickSpacing * 2, Math.floor(state.limits.rangeWidth / 2)),
      ),
      maxSwapImpactTicks: state.limits.maxDeviationTicks,
      swapSlippageBps: state.limits.maxSwapSlippageBps,
      liquiditySlippageBps: state.limits.maxLiquiditySlippageBps,
      deadlineSeconds: 90,
      minDeadlineSlackSeconds: 15,
      maxGasCostWei: gasLimitWei,
      gasBufferBps: 2500,
      maxSimulations: 12,
      simulationTimeoutMs: 15_000,
    },
  }
}

/** Stable JSONB representation: bigints are decimal strings, object key order is irrelevant. */
export function strategyJSON(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (typeof item === 'bigint') return item.toString()
    if (Array.isArray(item)) return item.map(normalize)
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      )
    return item
  }
  return JSON.stringify(normalize(value))
}

/** Never revive arbitrary serialized policy fields. Reconstruct and match the reviewed version. */
export function parseStrategyRunnerPolicy(
  value: unknown,
  snapshot: VerifiedStrategySnapshot,
  gasLimitWei: bigint,
  pins: StrategyRunnerPins = {},
): StrategyRunnerPolicy {
  const expected = createStrategyRunnerPolicy(snapshot, gasLimitWei, pins)
  if (strategyJSON(value) !== strategyJSON(expected))
    throw new Error('The stored runner policy differs from its reviewed version.')
  return expected
}
