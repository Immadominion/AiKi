import type { Hex } from 'viem'
import {
  MAX_TICK,
  MIN_TICK,
  mulDiv,
  mulDivRoundingUp,
  quoteAtTick,
  sqrtRatioAtTick,
} from './grid/math.js'
import { amountsForLiquidity, liquidityForAmounts, MAX_UINT128 } from './lp/liquidity.js'
import { isVerifiedLPPoolState, type VerifiedLPPoolState } from './lp/market.js'
import {
  encodeStrategyOperation,
  nonzeroHash,
  type StrategyOperation,
  strategyOperationDigest,
} from './operation.js'
import { isVerifiedStrategySimulation, type StrategySimulationQuote } from './simulation.js'
import { isVerifiedStrategySnapshot, type VerifiedStrategySnapshot } from './snapshot.js'

export type LPStrategyOperation = Extract<StrategyOperation, { kind: 'lp' }>
export interface LPPlannerPolicy {
  /** Reviewed server configuration, not an address or hash selected by a model. */
  poolRuntimeCodeHash: Hex
  maxSnapshotAgeSeconds: number
  /** Recenter near an existing edge; differing width also needs the owner-selected immutable width. */
  triggerEdgeTicks: number
  maxSwapImpactTicks: number
  swapSlippageBps: number
  liquiditySlippageBps: number
  deadlineSeconds: number
  minDeadlineSlackSeconds: number
  maxGasCostWei: bigint
  gasBufferBps: number
  maxSimulations: number
  simulationTimeoutMs: number
}
export type LPWaitCode =
  | 'INVALID_INPUT'
  | 'UNVERIFIED_STATE'
  | 'STALE_SNAPSHOT'
  | 'PAUSED'
  | 'EXPIRED'
  | 'COOLDOWN'
  | 'NO_POSITION'
  | 'POSITION_HEALTHY'
  | 'INSUFFICIENT_REMAINING_LIQUIDITY'
  | 'VALUE_LIMIT'
  | 'NO_ELIGIBLE_RANGE'
  | 'DEADLINE_TOO_CLOSE'
  | 'NO_ATOMIC_CANDIDATE'
  | 'GAS_BUDGET'
  | 'INVALID_SIMULATION'
  | 'SIMULATION_TIMEOUT'
export type LPDecision =
  | { act: false; code: LPWaitCode; reason: string; attemptedCandidates: number }
  | {
      act: true
      code: 'REBALANCE'
      reason: string
      operation: LPStrategyOperation
      quote: StrategySimulationQuote
      gasCostWei: bigint
      attemptedCandidates: number
    }
export type LPAtomicSimulator = (
  operation: LPStrategyOperation,
  snapshot: VerifiedStrategySnapshot,
) => Promise<StrategySimulationQuote | { status: 'blocked'; reason: string }>

const BPS = 10_000n
const MAX_SIMULATIONS = 12
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b))
const max = (a: bigint, b: bigint) => (a > b ? a : b)
const discount = (amount: bigint, bps: number) => mulDiv(amount, BPS - BigInt(bps), BPS)

/** At most three tick-aligned centers, deterministic even for negative and half-spacing ticks. */
export function lpRanges(
  twap: number,
  spot: number,
  width: number,
  spacing: number,
  maxOffset: number,
): { tickLower: number; tickUpper: number }[] {
  if (
    !integer(twap, MIN_TICK, MAX_TICK) ||
    !integer(spot, MIN_TICK, MAX_TICK) ||
    !integer(width, 1, MAX_TICK * 2) ||
    !integer(spacing, 1, MAX_TICK) ||
    width % spacing !== 0 ||
    !integer(maxOffset, 0, MAX_TICK)
  )
    return []
  const lower = Math.floor((twap * 2 - width) / (2 * spacing)) * spacing
  return [lower, lower + spacing, lower - spacing]
    .map((tickLower) => ({ tickLower, tickUpper: tickLower + width }))
    .filter(
      (r) =>
        r.tickLower >= MIN_TICK &&
        r.tickUpper <= MAX_TICK &&
        spot > r.tickLower &&
        spot < r.tickUpper &&
        Math.abs(r.tickLower + r.tickUpper - twap * 2) <= maxOffset * 2,
    )
    .sort(
      (a, b) =>
        Math.abs(a.tickLower + a.tickUpper - twap * 2) -
          Math.abs(b.tickLower + b.tickUpper - twap * 2) || a.tickLower - b.tickLower,
    )
}

/** Candidate arithmetic is a search seed, NEVER a claim about the pool after removing the old LP.
 * Only the injected complete manager simulation can establish the actual post-removal execution. */
export async function decideLP(
  input: {
    snapshot: VerifiedStrategySnapshot
    pool: VerifiedLPPoolState
    policy: LPPlannerPolicy
    nowSeconds: bigint
  },
  simulate: LPAtomicSimulator,
): Promise<LPDecision> {
  let attemptedCandidates = 0
  const wait = (code: LPWaitCode, reason: string): LPDecision => ({
    act: false,
    code,
    reason,
    attemptedCandidates,
  })
  const started = performance.now()
  try {
    const { snapshot, pool } = input
    const policy = structuredClone(input.policy),
      now = input.nowSeconds
    if (
      !isVerifiedStrategySnapshot(snapshot) ||
      snapshot.state.kind !== 'lp' ||
      !isVerifiedLPPoolState(pool) ||
      pool.snapshot !== snapshot ||
      pool.pool !== snapshot.state.protocol.pool ||
      pool.window !== snapshot.state.limits.twapWindow
    )
      return wait(
        'UNVERIFIED_STATE',
        'A complete LP snapshot and reviewed pool proof from the exact same finalized block are required.',
      )
    const state = snapshot.state,
      limits = state.limits,
      protocol = state.protocol
    if (
      typeof now !== 'bigint' ||
      now < 0n ||
      !nonzeroHash(policy.poolRuntimeCodeHash) ||
      pool.runtimeCodeHash !== policy.poolRuntimeCodeHash.toLowerCase() ||
      !integer(policy.maxSnapshotAgeSeconds, 1, 30) ||
      !integer(policy.triggerEdgeTicks, 1, Math.floor(limits.rangeWidth / 2)) ||
      !integer(policy.maxSwapImpactTicks, 1, limits.maxDeviationTicks) ||
      !integer(policy.swapSlippageBps, 0, limits.maxSwapSlippageBps) ||
      !integer(policy.liquiditySlippageBps, 0, limits.maxLiquiditySlippageBps) ||
      !integer(policy.deadlineSeconds, 1, 3600) ||
      !integer(policy.minDeadlineSlackSeconds, 1, policy.deadlineSeconds) ||
      !integer(policy.gasBufferBps, 0, 10_000) ||
      !integer(policy.maxSimulations, 1, MAX_SIMULATIONS) ||
      !integer(policy.simulationTimeoutMs, 1, 30_000) ||
      typeof policy.maxGasCostWei !== 'bigint' ||
      policy.maxGasCostWei <= 0n ||
      policy.maxGasCostWei >= 1n << 256n
    )
      return wait(
        'INVALID_INPUT',
        'LP planner policy must stay within the immutable vault limits and an explicit native gas budget.',
      )
    if (
      snapshot.block.timestamp > now ||
      now - snapshot.block.timestamp > BigInt(policy.maxSnapshotAgeSeconds)
    )
      return wait(
        'STALE_SNAPSHOT',
        'Refresh the finalized vault and pool snapshot before planning an LP replacement.',
      )
    if (snapshot.paused)
      return wait('PAUSED', 'The owner has paused this vault; no replacement is planned.')
    if (snapshot.expiresAt <= now)
      return wait(
        'EXPIRED',
        'The immutable LP policy has expired; owner recovery remains separate.',
      )
    if (
      snapshot.lastExecutionAt > 0n &&
      snapshot.block.timestamp < snapshot.lastExecutionAt + snapshot.minInterval
    )
      return wait('COOLDOWN', 'The minimum interval has not elapsed on the verified block.')
    const position = state.position
    if (
      !state.enrolled ||
      !position ||
      state.currentTokenId === 0n ||
      state.positionLiquidity === 0n ||
      position.owner !== snapshot.binding.vault
    )
      return wait(
        'NO_POSITION',
        'No enrolled, unstaked NFT in verified vault custody is available to rebalance.',
      )
    const active = pool.spot >= position.tickLower && pool.spot < position.tickUpper
    const remainingLiquidity = pool.liquidity - (active ? state.positionLiquidity : 0n)
    if (remainingLiquidity < limits.minPoolLiquidity)
      return wait(
        'INSUFFICIENT_REMAINING_LIQUIDITY',
        'Removing this NFT would leave too little pool liquidity before the swap and replacement mint.',
      )
    if (
      position.tickUpper - position.tickLower === limits.rangeWidth &&
      pool.spot - position.tickLower > policy.triggerEdgeTicks &&
      position.tickUpper - pool.spot > policy.triggerEdgeTicks &&
      Math.abs(position.tickLower + position.tickUpper - pool.twap * 2) <=
        limits.maxCenterOffsetTicks * 2
    )
      return wait(
        'POSITION_HEALTHY',
        'The existing position has the configured width and is away from its edges; no gas-spending replacement is needed.',
      )
    const deadline = min(
      snapshot.expiresAt,
      now + BigInt(policy.deadlineSeconds),
      snapshot.block.timestamp + snapshot.maxDeadlineDelay,
    )
    if (deadline - now < BigInt(policy.minDeadlineSlackSeconds))
      return wait(
        'DEADLINE_TOO_CLOSE',
        'The verified block is too old for a replacement with enough deadline slack.',
      )
    const ranges = lpRanges(
      pool.twap,
      pool.spot,
      limits.rangeWidth,
      protocol.tickSpacing,
      limits.maxCenterOffsetTicks,
    ).filter((r) => r.tickLower !== position.tickLower || r.tickUpper !== position.tickUpper)
    if (!ranges.length)
      return wait(
        'NO_ELIGIBLE_RANGE',
        'No distinct centered, tick-aligned range fits the immutable policy and current pool price.',
      )
    const principal = amountsForLiquidity(
      pool.sqrtPriceX96,
      sqrtRatioAtTick(position.tickLower),
      sqrtRatioAtTick(position.tickUpper),
      position.liquidity,
    )
    // Recorded fees are inventory; uncheckpointed fee growth is NOT invented. Full simulation
    // performs the real collect and includes all collected fees on both sides of the loss check.
    const inventory: [bigint, bigint] = [
      state.idle0 + principal[0] + position.tokensOwed0,
      state.idle1 + principal[1] + position.tokensOwed1,
    ]
    const value = (a0: bigint, a1: bigint) =>
      protocol.quoteToken === protocol.token0
        ? a0 + quoteAtTick(pool.twap, a1, protocol.token1, protocol.token0)
        : a1 + quoteAtTick(pool.twap, a0, protocol.token0, protocol.token1)
    if (
      inventory.some((amount) => amount > MAX_UINT128) ||
      value(...inventory) === 0n ||
      value(...inventory) > limits.maxPositionValueQuote
    )
      return wait(
        'VALUE_LIMIT',
        'The tracked position value cannot fit the immutable quote-token allocation limit.',
      )
    const swapOutput = (amount: bigint, zeroForOne: boolean, slippage = 0) =>
      discount(
        mulDiv(
          quoteAtTick(
            pool.twap,
            amount,
            zeroForOne ? protocol.token0 : protocol.token1,
            zeroForOne ? protocol.token1 : protocol.token0,
          ),
          BigInt(1_000_000 - protocol.fee),
          1_000_000n,
        ),
        slippage,
      )
    const candidate = (
      range: { tickLower: number; tickUpper: number },
      swapAmount = 0n,
      zeroForOne = true,
    ): LPStrategyOperation | null => {
      const amounts: [bigint, bigint] = [...inventory]
      let minSwapOut = 0n,
        sqrtPriceLimitX96 = 0n
      if (swapAmount > 0n) {
        const index = zeroForOne ? 0 : 1
        if (
          swapAmount > amounts[index] ||
          swapAmount > (zeroForOne ? limits.maxSwap0 : limits.maxSwap1)
        )
          return null
        minSwapOut = swapOutput(
          mulDivRoundingUp(swapAmount, BigInt(limits.minSwapFillBps), BPS),
          zeroForOne,
          policy.swapSlippageBps,
        )
        if (minSwapOut === 0n) return null
        const boundary = zeroForOne
          ? Math.max(
              pool.twap - limits.maxDeviationTicks,
              pool.spot - policy.maxSwapImpactTicks,
              range.tickLower + 1,
            )
          : Math.min(
              pool.twap + limits.maxDeviationTicks,
              pool.spot + policy.maxSwapImpactTicks,
              range.tickUpper - 1,
            )
        if (boundary <= MIN_TICK || boundary >= MAX_TICK) return null
        sqrtPriceLimitX96 = sqrtRatioAtTick(boundary)
        if (
          zeroForOne
            ? sqrtPriceLimitX96 >= pool.sqrtPriceX96
            : sqrtPriceLimitX96 <= pool.sqrtPriceX96
        )
          return null
        if (zeroForOne) {
          amounts[0] -= swapAmount
          amounts[1] += swapOutput(swapAmount, true)
        } else {
          amounts[1] -= swapAmount
          amounts[0] += swapOutput(swapAmount, false)
        }
      }
      if (amounts.some((amount) => amount > MAX_UINT128)) return null
      const a = sqrtRatioAtTick(range.tickLower),
        b = sqrtRatioAtTick(range.tickUpper)
      const liquidity = liquidityForAmounts(pool.sqrtPriceX96, a, b, ...amounts)
      if (liquidity === 0n) return null
      const deployed = amountsForLiquidity(pool.sqrtPriceX96, a, b, liquidity)
      const deployedValue = value(...deployed)
      if (
        deployedValue === 0n ||
        deployedValue < mulDivRoundingUp(value(...amounts), BigInt(limits.minDeployedBps), BPS)
      )
        return null
      const operation: LPStrategyOperation = {
        kind: 'lp',
        binding: { ...snapshot.binding },
        expectedNonce: snapshot.nonce,
        expectedTokenId: state.currentTokenId,
        ...range,
        zeroForOne,
        swapAmount,
        minSwapOut,
        sqrtPriceLimitX96,
        minBurn0: discount(principal[0], policy.liquiditySlippageBps),
        minBurn1: discount(principal[1], policy.liquiditySlippageBps),
        minMint0: discount(deployed[0], policy.liquiditySlippageBps),
        minMint1: discount(deployed[1], policy.liquiditySlippageBps),
        minLiquidity: max(1n, discount(liquidity, policy.liquiditySlippageBps)),
        deadline,
      }
      encodeStrategyOperation(operation)
      Object.freeze(operation.binding)
      return Object.freeze(operation)
    }
    // Every eligible no-swap range precedes any swap candidate. The search never calls a quoter.
    function* candidates(): Generator<LPStrategyOperation> {
      for (const range of ranges) {
        const operation = candidate(range)
        if (operation) yield operation
      }
      for (const range of ranges) {
        const [unit0, unit1] = amountsForLiquidity(
          pool.sqrtPriceX96,
          sqrtRatioAtTick(range.tickLower),
          sqrtRatioAtTick(range.tickUpper),
          1n << 96n,
        )
        if (unit0 === 0n || unit1 === 0n) continue
        const excess0 = inventory[0] * unit1 - inventory[1] * unit0
        if (excess0 === 0n) continue
        const zeroForOne = excess0 > 0n
        const cap = min(
          zeroForOne ? inventory[0] : inventory[1],
          zeroForOne ? limits.maxSwap0 : limits.maxSwap1,
          MAX_UINT128,
        )
        let low = 0n,
          high = cap
        // A monotonic no-impact balance estimate seeds the search, not execution. uint128
        // search is capped at 128 bisections, then only three nearby exact-input sizes are tested.
        for (let i = 0; i < 128 && low < high; i++) {
          const mid = (low + high) / 2n
          const after0 = zeroForOne ? inventory[0] - mid : inventory[0] + swapOutput(mid, false)
          const after1 = zeroForOne ? inventory[1] + swapOutput(mid, true) : inventory[1] - mid
          const stillExcess = zeroForOne
            ? after0 * unit1 > after1 * unit0
            : after1 * unit0 > after0 * unit1
          if (stillExcess) low = mid + 1n
          else high = mid
        }
        for (const amount of new Set([
          low,
          mulDiv(low, 9000n, BPS),
          min(cap, mulDivRoundingUp(low, 11000n, BPS)),
        ])) {
          if (amount === 0n) continue
          const op = candidate(range, amount, zeroForOne)
          if (op) yield op
        }
      }
    }
    let gasRefused = false
    for (const operation of candidates()) {
      if (attemptedCandidates >= policy.maxSimulations) break
      const current = now + BigInt(Math.ceil((performance.now() - started) / 1000))
      if (
        current - snapshot.block.timestamp > BigInt(policy.maxSnapshotAgeSeconds) ||
        deadline - current < BigInt(policy.minDeadlineSlackSeconds)
      )
        return wait(
          'DEADLINE_TOO_CLOSE',
          'Refresh chain state before continuing; simulation would leave insufficient deadline slack.',
        )
      attemptedCandidates++
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = Symbol('simulation-timeout')
      let result: Awaited<ReturnType<LPAtomicSimulator>> | typeof timeout
      try {
        result = await Promise.race([
          simulate(operation, snapshot),
          new Promise<typeof timeout>((resolve) => {
            timer = setTimeout(() => resolve(timeout), policy.simulationTimeoutMs)
          }),
        ])
      } catch {
        continue
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (result === timeout)
        return wait(
          'SIMULATION_TIMEOUT',
          'The complete manager simulation timed out; no replacement is authorized.',
        )
      if (result.status === 'blocked') continue
      if (
        !isVerifiedStrategySimulation(result) ||
        result.path !== 'manager-delegation' ||
        result.blockNumber !== snapshot.block.number ||
        result.blockHash !== snapshot.block.hash ||
        result.operationDigest !== strategyOperationDigest(operation) ||
        !nonzeroHash(result.envelopeHash)
      )
        return wait(
          'INVALID_SIMULATION',
          'The simulation proof does not match this exact full-manager replacement and finalized block.',
        )
      const after = now + BigInt(Math.ceil((performance.now() - started) / 1000))
      if (
        after - snapshot.block.timestamp > BigInt(policy.maxSnapshotAgeSeconds) ||
        deadline - after < BigInt(policy.minDeadlineSlackSeconds)
      )
        return wait(
          'DEADLINE_TOO_CLOSE',
          'The simulated replacement no longer has sufficient fresh-block deadline slack.',
        )
      const gasCostWei = mulDivRoundingUp(
        result.gasUnits,
        result.gasPriceWei * (BPS + BigInt(policy.gasBufferBps)),
        BPS,
      )
      if (gasCostWei > policy.maxGasCostWei) {
        gasRefused = true
        continue
      }
      return {
        act: true,
        code: 'REBALANCE',
        reason:
          'A bounded replacement passed full atomic manager simulation within the explicit gas budget. Market movement, impermanent loss and profit are not guaranteed.',
        operation,
        quote: result,
        gasCostWei,
        attemptedCandidates,
      }
    }
    return gasRefused
      ? wait(
          'GAS_BUDGET',
          'Passing full atomic replacements exceed the explicit native gas budget.',
        )
      : wait(
          'NO_ATOMIC_CANDIDATE',
          'No candidate in the bounded search passed the complete remove, collect, optional swap and replacement-mint simulation.',
        )
  } catch {
    return wait(
      'INVALID_INPUT',
      'The LP inputs or exact integer candidate arithmetic could not be validated; no replacement is authorized.',
    )
  }
}
