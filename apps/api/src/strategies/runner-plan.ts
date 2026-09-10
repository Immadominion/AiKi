import type { SignedDelegation } from '../execution/executor.js'
import { readGridMarketSnapshot } from './grid/market.js'
import { planGrid } from './grid-planner.js'
import { readLPPoolState } from './lp/market.js'
import { decideLP } from './lp-planner.js'
import { nonzeroHash, type StrategyOperation, strategyOperationDigest } from './operation.js'
import type { StrategyRunnerPolicy } from './runner-policy.js'
import {
  isVerifiedStrategySimulation,
  quoteStrategyOperation,
  type StrategySimulationQuote,
  type StrategySimulationReader,
} from './simulation.js'
import type { StrategySnapshotReader, VerifiedStrategySnapshot } from './snapshot.js'
import { canonicalYieldResolvers } from './yield/mainnet-resolvers.js'
import { readYieldSnapshot, type YieldSnapshotConfig } from './yield/snapshot.js'
import type { YieldPlannerState } from './yield/types.js'
import { decideYield } from './yield-planner.js'

export type StrategyPlanReader = StrategySnapshotReader &
  StrategySimulationReader &
  Parameters<typeof readYieldSnapshot>[0]
export type StrategyPassPlan =
  | { act: false; code: string; reason: string; nextState?: YieldPlannerState }
  | {
      act: true
      operation: StrategyOperation
      quote: StrategySimulationQuote
      gasBudgetWei: bigint
      nextState?: YieldPlannerState
    }

/** Planner history is observational only. Stored JSON cannot introduce a pending execution. */
export function decodeYieldRunnerState(value: unknown): YieldPlannerState {
  const fail = (): never => {
    throw new Error('Invalid yield observation checkpoint.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).length === 0) return {}
  if (
    Object.keys(raw).length !== 1 ||
    !raw.lastObservation ||
    typeof raw.lastObservation !== 'object' ||
    Array.isArray(raw.lastObservation)
  )
    return fail()
  const v = raw.lastObservation as Record<string, unknown>
  if (
    Object.keys(v).length !== 6 ||
    !['blockNumber', 'blockHash', 'timestamp', 'candidate', 'count', 'nonce'].every((k) =>
      Object.hasOwn(v, k),
    )
  )
    return fail()
  const uint = (v: unknown): bigint =>
    typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 78 && BigInt(v) < 1n << 256n
      ? BigInt(v)
      : fail()
  if (
    !nonzeroHash(v.blockHash) ||
    typeof v.timestamp !== 'number' ||
    !Number.isSafeInteger(v.timestamp) ||
    v.timestamp < 0 ||
    typeof v.count !== 'number' ||
    !Number.isInteger(v.count) ||
    v.count < 1 ||
    v.count > 2 ||
    typeof v.candidate !== 'string' ||
    !/^(idle|venus|aave):(idle|venus|aave)$/.test(v.candidate) ||
    v.candidate.split(':')[0] === v.candidate.split(':')[1]
  )
    return fail()
  return {
    lastObservation: {
      blockNumber: uint(v.blockNumber),
      blockHash: v.blockHash,
      timestamp: v.timestamp,
      candidate: v.candidate,
      count: v.count,
      nonce: uint(v.nonce),
    },
  }
}

/** Read-only planning. Execution is a separate durable step and cannot happen from here. */
export async function planStrategyPass(input: {
  snapshot: VerifiedStrategySnapshot
  policy: StrategyRunnerPolicy
  delegation: SignedDelegation
  executor: `0x${string}`
  reader: StrategyPlanReader
  plannerState: unknown
  yieldConfig?: YieldSnapshotConfig
  gasLimitWei: bigint
  now?: () => number
}): Promise<StrategyPassPlan> {
  const { snapshot, policy, reader } = input
  const now = input.now ?? (() => Math.floor(Date.now() / 1000))
  const simulate = (operation: StrategyOperation) =>
    quoteStrategyOperation({
      operation,
      snapshot,
      reader,
      delegation: input.delegation,
      executor: input.executor,
    })
  if (policy.kind !== snapshot.state.kind)
    return { act: false, code: 'POLICY_MISMATCH', reason: 'The saved strategy limits need review.' }
  if (policy.kind === 'grid') {
    const proof = await readGridMarketSnapshot(snapshot, reader)
    if (proof.status !== 'verified')
      return {
        act: false,
        code: 'MARKET_UNAVAILABLE',
        reason: 'Waiting for verified pool prices and liquidity.',
      }
    const result = await planGrid({
      snapshot,
      market: proof.market,
      policy: policy.planner,
      now,
      simulate,
    })
    return result.act
      ? {
          act: true,
          operation: result.operation,
          quote: result.quote,
          gasBudgetWei: result.bufferedGasCostWei,
        }
      : result
  }
  if (policy.kind === 'lp') {
    const proof = await readLPPoolState(
      snapshot,
      { runtimeCodeHash: policy.planner.poolRuntimeCodeHash },
      reader,
    )
    if (proof.status !== 'verified')
      return {
        act: false,
        code: 'MARKET_UNAVAILABLE',
        reason: 'Waiting for verified pool prices and liquidity.',
      }
    const result = await decideLP(
      { snapshot, pool: proof.market, policy: policy.planner, nowSeconds: BigInt(now()) },
      simulate,
    )
    return result.act
      ? {
          act: true,
          operation: result.operation,
          quote: result.quote,
          gasBudgetWei: result.gasCostWei,
        }
      : result
  }
  if (!input.yieldConfig)
    return {
      act: false,
      code: 'CONFIG_UNAVAILABLE',
      reason: 'Reviewed yield venues are unavailable.',
    }
  const history = decodeYieldRunnerState(input.plannerState)
  const evidence = await readYieldSnapshot(
    reader,
    input.yieldConfig,
    canonicalYieldResolvers,
    snapshot,
  )
  if (evidence.nonce !== snapshot.nonce || evidence.paused !== snapshot.paused)
    return {
      act: false,
      code: 'STATE_CHANGED',
      reason: 'Vault state changed. Waiting for a fresh read.',
    }
  let result = decideYield(evidence, policy.planner, history, now())
  if (result.act || result.code !== 'QUOTE_REQUIRED' || !result.candidates?.length)
    return result.act
      ? {
          act: false,
          code: 'INVALID_SIMULATION',
          reason: 'A fresh complete transaction quote is required.',
        }
      : result
  if (result.candidates.length > 24)
    return {
      act: false,
      code: 'QUOTE_LIMIT',
      reason: 'The yield quote set exceeded its reviewed limit.',
    }
  const candidates = result.candidates
  const deadline = [
    snapshot.block.timestamp + 90n,
    snapshot.block.timestamp + snapshot.maxDeadlineDelay,
    snapshot.expiresAt,
  ].reduce((a, b) => (a < b ? a : b))
  const quotes = new Map<string, { operation: StrategyOperation; quote: StrategySimulationQuote }>()
  const venue = { idle: 0, venus: 1, aave: 2 } as const
  // At most four concurrent read-only simulations, all tied to the same canonical block.
  for (let offset = 0; offset < candidates.length; offset += 4) {
    if (BigInt(now()) - snapshot.block.timestamp > 25n || deadline - BigInt(now()) < 15n)
      return {
        act: false,
        code: 'STALE_SNAPSHOT',
        reason: 'Refreshing prices before another quote.',
      }
    await Promise.all(
      candidates.slice(offset, offset + 4).map(async (candidate) => {
        const operation: StrategyOperation = {
          kind: 'yield',
          binding: snapshot.binding,
          expectedNonce: snapshot.nonce,
          deadline,
          source: venue[candidate.source],
          destination: venue[candidate.destination],
          assets: candidate.assets,
          minReceived: candidate.expectedMoved,
        }
        const quote = await simulate(operation)
        if (!isVerifiedStrategySimulation(quote)) return
        quotes.set(strategyOperationDigest(operation), { operation, quote })
        evidence.executionQuotes.push({
          vault: evidence.vault,
          policyHash: evidence.policyHash,
          blockNumber: quote.blockNumber,
          blockHash: quote.blockHash,
          nonce: snapshot.nonce,
          source: candidate.source,
          destination: candidate.destination,
          assets: candidate.assets,
          minReceived: candidate.expectedMoved,
          deadline: Number(deadline),
          path: 'manager-delegation',
          simulated: true,
          gasUnits: quote.gasUnits,
          gasPriceWei: quote.gasPriceWei,
          unwindGasUnits: quote.gasUnits > 2_000_000n ? quote.gasUnits : 2_000_000n,
        })
      }),
    )
  }
  result = decideYield(evidence, policy.planner, history, now())
  if (!result.act) return result
  const operation: StrategyOperation = {
    kind: 'yield',
    binding: snapshot.binding,
    expectedNonce: snapshot.nonce,
    deadline: BigInt(result.plan.deadline),
    source: venue[result.plan.source],
    destination: venue[result.plan.destination],
    assets: result.plan.assets,
    minReceived: result.plan.minReceived,
  }
  const proven = quotes.get(strategyOperationDigest(operation))
  if (!proven)
    return {
      act: false,
      code: 'INVALID_SIMULATION',
      reason: 'The selected move has no matching transaction quote.',
    }
  const gasBudgetWei =
    (proven.quote.gasUnits *
      proven.quote.gasPriceWei *
      BigInt(10_000 + policy.planner.gasBufferBps) +
      9_999n) /
    10_000n
  if (gasBudgetWei > input.gasLimitWei)
    return {
      act: false,
      code: 'GAS_LIMIT',
      reason: 'Gas exceeds the limit you approved.',
      nextState: result.nextState,
    }
  return { act: true, ...proven, gasBudgetWei, nextState: result.nextState }
}
