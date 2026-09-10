import { isVerifiedGridMarketSnapshot, type VerifiedGridMarketSnapshot } from './grid/market.js'
import { mulDiv, mulDivRoundingUp, quoteAtTick, sqrtRatioAtTick } from './grid/math.js'
import type { StrategyOperation } from './operation.js'
import { strategyOperationDigest } from './operation.js'
import { isVerifiedStrategySimulation, type StrategySimulationQuote } from './simulation.js'
import { isVerifiedStrategySnapshot, type VerifiedStrategySnapshot } from './snapshot.js'

type GridOperation = Extract<StrategyOperation, { kind: 'grid' }>
export interface GridPlannerPolicy {
  maxSnapshotAgeSeconds: number
  deadlineSeconds: number
  maxGasUnits: bigint
  maxGasPriceWei: bigint
  maxGasCostWei: bigint
  gasBufferBps: number
}
export interface GridPlannerRequest {
  snapshot: VerifiedStrategySnapshot
  market: VerifiedGridMarketSnapshot
  policy: GridPlannerPolicy
  /** Any unresolved intent blocks a new pass, regardless of its prepared nonce. */
  pendingNonce?: bigint
  now(): number
  simulate(
    operation: GridOperation,
  ): Promise<StrategySimulationQuote | { status: 'blocked'; reason: string }>
}
export type GridWaitCode =
  | 'INVALID_INPUT'
  | 'UNVERIFIED_STATE'
  | 'STALE_SNAPSHOT'
  | 'PENDING_EXECUTION'
  | 'PAUSED'
  | 'EXPIRED'
  | 'COOLDOWN'
  | 'OUTSIDE_GRID'
  | 'NO_INVENTORY'
  | 'NO_TRANSITION'
  | 'SIMULATION_REQUIRED'
  | 'GAS_LIMIT'
export type GridDecision =
  | { act: false; code: GridWaitCode; reason: string }
  | {
      act: true
      code: 'READY'
      transition: 'baseline' | 'arm' | 'fill'
      operation: GridOperation
      quote: StrategySimulationQuote
      bufferedGasCostWei: bigint
      /** Nominal exact-input ceiling, NOT a promised actual fill; partial fills are permitted.
       * Only a finalized receipt + refreshed snapshot may update actual arming/inventory. */
      expectedInput: bigint
    }
const wait = (code: GridWaitCode, reason: string): GridDecision => ({ act: false, code, reason })
const positive = (v: unknown): v is bigint => typeof v === 'bigint' && v > 0n && v < 1n << 256n
const seconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** No RPC or transactions: only the injected full-manager simulator can perform read-only
 * checks. This does NOT mutate watches, reserve a nonce, or turn a quote into execution.
 * Planning an observation is justified only by a baseline/arming transition; unchanged
 * ticks never create paid maintenance passes. The vault remains the authority for fills. */
export async function planGrid(input: GridPlannerRequest): Promise<GridDecision> {
  try {
    const { snapshot, market, pendingNonce } = input
    const policy = structuredClone(input.policy)
    const now = input.now()
    if (
      !seconds(now) ||
      !seconds(policy.maxSnapshotAgeSeconds) ||
      policy.maxSnapshotAgeSeconds < 1 ||
      policy.maxSnapshotAgeSeconds > 3600 ||
      !seconds(policy.deadlineSeconds) ||
      policy.deadlineSeconds < 1 ||
      policy.deadlineSeconds > 300 ||
      !seconds(policy.gasBufferBps) ||
      policy.gasBufferBps > 10000 ||
      ![policy.maxGasUnits, policy.maxGasPriceWei, policy.maxGasCostWei].every(positive)
    )
      return wait(
        'INVALID_INPUT',
        'A bounded explicit gas, freshness and deadline policy is required.',
      )
    if (
      !isVerifiedStrategySnapshot(snapshot) ||
      snapshot.state.kind !== 'grid' ||
      !isVerifiedGridMarketSnapshot(market, snapshot)
    )
      return wait(
        'UNVERIFIED_STATE',
        'Complete verified custody and same-block grid market state are required.',
      )
    const s = snapshot.state,
      p = s.policy
    const fresh = (time: number) =>
      seconds(time) &&
      BigInt(time) >= snapshot.block.timestamp &&
      BigInt(time) - snapshot.block.timestamp <= BigInt(policy.maxSnapshotAgeSeconds)
    if (!fresh(now))
      return wait('STALE_SNAPSHOT', 'The finalized grid snapshot is stale or from the future.')
    if (pendingNonce !== undefined)
      return wait(
        'PENDING_EXECUTION',
        'Reconcile the unresolved grid operation before another pass.',
      )
    if (snapshot.paused)
      return wait('PAUSED', 'The owner has paused or not yet enabled this vault.')
    if (BigInt(now) >= snapshot.expiresAt)
      return wait('EXPIRED', 'The immutable grid authority has expired.')
    if (
      snapshot.lastExecutionAt !== 0n &&
      BigInt(now) < snapshot.lastExecutionAt + snapshot.minInterval
    )
      return wait('COOLDOWN', 'The immutable minimum interval has not elapsed.')
    if (
      snapshot.nonce >= (1n << 256n) - 1n ||
      s.observationNonce > snapshot.nonce ||
      market.allowance0 !== 0n ||
      market.allowance1 !== 0n ||
      p.hysteresisTicks < 1 ||
      p.minFillBps < 100 ||
      p.minFillBps > 10000 ||
      p.maxSlippageBps > 500 ||
      snapshot.maxDeadlineDelay === 0n
    )
      return wait('UNVERIFIED_STATE', 'Invalid nonce, allowance or immutable grid policy state.')
    if (market.spot < p.tickLower || market.spot >= p.tickUpper)
      return wait(
        'OUTSIDE_GRID',
        'Price is outside the immutable grid; no regrid or maintenance trade is permitted.',
      )
    const eligible = s.rungs
      .flatMap((rung) => {
        const sell = rung.state.nextSell
        const available = sell ? rung.state.inventory0 : rung.state.inventory1
        const lot = sell ? rung.policy.lot0 : rung.policy.lot1
        const amount = available < lot ? available : lot
        const turnover = sell ? s.turnover0 : s.turnover1
        const cap = sell ? p.turnoverCap0 : p.turnoverCap1
        if (
          amount <= 0n ||
          amount > (sell ? p.maxInput0 : p.maxInput1) ||
          turnover + amount > cap ||
          (!sell === rung.policy.initialSell && rung.state.cycle === (1n << 64n) - 1n)
        )
          return []
        const qualifies = sell
          ? market.spot <= rung.policy.sellTick - p.hysteresisTicks
          : market.spot >= rung.policy.buyTick + p.hysteresisTicks
        const limit = sqrtRatioAtTick(sell ? rung.policy.sellTick : rung.policy.buyTick)
        const crossed =
          rung.state.armed &&
          (sell
            ? market.spot >= rung.policy.sellTick && market.sqrtPriceX96 > limit
            : market.spot <= rung.policy.buyTick && market.sqrtPriceX96 < limit)
        const minimumInput = mulDivRoundingUp(amount, BigInt(p.minFillBps), 10000n)
        const tokenIn = sell ? s.protocol.token0 : s.protocol.token1
        const tokenOut = sell ? s.protocol.token1 : s.protocol.token0
        const atRung = quoteAtTick(
          sell ? rung.policy.sellTick : rung.policy.buyTick,
          minimumInput,
          tokenIn,
          tokenOut,
        )
        const atTwap = quoteAtTick(market.twap, minimumInput, tokenIn, tokenOut)
        const minimumOutput = mulDiv(
          mulDiv(atRung > atTwap ? atRung : atTwap, 1000000n - BigInt(s.protocol.fee), 1000000n),
          10000n - BigInt(p.maxSlippageBps),
          10000n,
        )
        return minimumOutput === 0n ? [] : [{ rung, amount, qualifies, crossed }]
      })
      .sort((a, b) => a.rung.index - b.rung.index)
    if (eligible.length === 0)
      return wait(
        'NO_INVENTORY',
        'No funded rung can trade within its input, turnover, cycle and nonzero-output limits.',
      )
    const baseline = !s.initialized || s.observationNonce !== snapshot.nonce
    const selected = baseline
      ? eligible[0]
      : (eligible.find((item) => item.crossed) ??
        eligible.find((item) => !item.rung.state.armed && item.qualifies))
    if (!selected)
      return wait(
        'NO_TRANSITION',
        'No funded crossing or new arming transition requires an onchain observation.',
      )
    const transition = baseline ? 'baseline' : selected.crossed ? 'fill' : 'arm'
    const delay =
      BigInt(policy.deadlineSeconds) < snapshot.maxDeadlineDelay
        ? BigInt(policy.deadlineSeconds)
        : snapshot.maxDeadlineDelay
    const proposedDeadline = BigInt(now) + delay
    const snapshotDeadline = snapshot.block.timestamp + snapshot.maxDeadlineDelay
    const deadline = [proposedDeadline, snapshot.expiresAt, snapshotDeadline].reduce((a, b) =>
      a < b ? a : b,
    )
    if (deadline <= BigInt(now))
      return wait(
        'STALE_SNAPSHOT',
        'The same-block simulation deadline has elapsed; refresh the snapshot.',
      )
    const operation: GridOperation = Object.freeze({
      kind: 'grid',
      binding: Object.freeze({ ...snapshot.binding }),
      expectedNonce: snapshot.nonce,
      deadline,
      rungIndex: selected.rung.index,
      before: Object.freeze({ ...selected.rung.state }),
      baseline,
    })
    const digest = strategyOperationDigest(operation)
    const quote = await input.simulate(operation)
    const after = input.now()
    if (
      !fresh(after) ||
      after < now ||
      BigInt(after) >= deadline ||
      BigInt(after) >= snapshot.expiresAt
    )
      return wait(
        'STALE_SNAPSHOT',
        'The snapshot or operation deadline expired during simulation; refresh before planning.',
      )
    if (
      !isVerifiedStrategySimulation(quote) ||
      quote.status !== 'simulated' ||
      quote.path !== 'manager-delegation' ||
      quote.operationDigest !== digest ||
      quote.blockNumber !== snapshot.block.number ||
      quote.blockHash.toLowerCase() !== snapshot.block.hash.toLowerCase()
    )
      return wait(
        'SIMULATION_REQUIRED',
        'The exact operation needs a verified complete manager simulation at this snapshot.',
      )
    if (
      !positive(quote.gasUnits) ||
      !positive(quote.gasPriceWei) ||
      quote.gasUnits > policy.maxGasUnits ||
      quote.gasPriceWei > policy.maxGasPriceWei
    )
      return wait('GAS_LIMIT', 'The complete manager transaction exceeds its explicit gas limits.')
    const bufferedGasCostWei = mulDivRoundingUp(
      quote.gasUnits * quote.gasPriceWei,
      10000n + BigInt(policy.gasBufferBps),
      10000n,
    )
    if (bufferedGasCostWei > policy.maxGasCostWei)
      return wait('GAS_LIMIT', 'Buffered native gas cost exceeds the explicit grid budget.')
    return {
      act: true,
      code: 'READY',
      transition,
      operation,
      quote,
      bufferedGasCostWei,
      expectedInput: transition === 'fill' ? selected.amount : 0n,
    }
  } catch {
    return wait(
      'INVALID_INPUT',
      'Malformed or unavailable grid planning evidence; no operation is ready.',
    )
  }
}
