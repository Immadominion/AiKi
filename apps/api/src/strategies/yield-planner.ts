import {
  ceilDiv,
  fullGasCost,
  maxBig,
  minBig,
  normalizeYieldRate,
  supplyRateAfter,
  YIELD_RAY,
  YIELD_WAD,
  YIELD_YEAR,
} from './yield/rates.js'
import type {
  YieldCandidate,
  YieldDecision,
  YieldPlannerPolicy,
  YieldPlannerState,
  YieldReason,
  YieldSnapshot,
  YieldVaultLimits,
  YieldVenueId,
  YieldVenueSnapshot,
} from './yield/types.js'

export type * from './yield/types.js'

export const YIELD_CANONICAL = {
  underlying: '0x55d398326f99059ff775485246999027b3197955',
  venus: '0xfd5840cd36d94d7229439859c0112a4185bc0255',
  aave: '0x6807dc923806fe8fd134338eabca509979a7e0cb',
  aaveReceipt: '0xa9251ca9de909cb71783723713b21e4233fbf1b1',
} as const

const BPS = 10_000n
const VENUES = ['venus', 'aave'] as const
const limitKeys = [
  'maxPrincipal',
  'maxMove',
  'maxTurnover',
  'minIdle',
  'maxVenusExposure',
  'maxAaveExposure',
  'maxLossPerMove',
  'maxCumulativeLoss',
  'maxLossBps',
] as const
const address = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v)
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v)
const equal = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const uint = (v: unknown): v is bigint => typeof v === 'bigint' && v >= 0n && v < 2n ** 256n
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const positive = (v: unknown): v is number => integer(v) && v > 0

function validLimits(limits: YieldVaultLimits): boolean {
  return (
    limitKeys.every((key) => (key === 'maxLossBps' ? integer(limits[key]) : uint(limits[key]))) &&
    limits.maxPrincipal > 0n &&
    limits.maxMove > 0n &&
    limits.maxMove <= limits.maxPrincipal &&
    limits.maxTurnover >= limits.maxMove &&
    limits.minIdle <= limits.maxPrincipal &&
    limits.maxLossBps < 10_000 &&
    limits.maxLossPerMove <= limits.maxMove &&
    limits.maxCumulativeLoss >= limits.maxLossPerMove &&
    (limits.maxVenusExposure > 0n || limits.maxAaveExposure > 0n)
  )
}

function validate(
  snapshot: YieldSnapshot,
  policy: YieldPlannerPolicy,
  now: number,
): YieldReason | null {
  if (
    !integer(now) ||
    !validLimits(policy.limits) ||
    !validLimits(snapshot.limits) ||
    !address(policy.vault) ||
    !address(policy.controller) ||
    !hash(policy.policyHash) ||
    !positive(policy.horizonSeconds) ||
    policy.horizonSeconds > 365 * 86_400 ||
    !positive(policy.maxSnapshotAgeSeconds) ||
    policy.maxSnapshotAgeSeconds > 3_600 ||
    !positive(policy.maxPriceAgeSeconds) ||
    !positive(policy.minClockSampleSeconds) ||
    policy.minClockSampleSeconds > 86_400 ||
    !positive(policy.maxObservationGapSeconds) ||
    !positive(policy.requiredObservations) ||
    policy.requiredObservations > 100 ||
    !integer(policy.minObservationSeconds) ||
    !integer(policy.gasBufferBps) ||
    policy.gasBufferBps > 10_000 ||
    !integer(policy.minIdleBps) ||
    policy.minIdleBps > 10_000 ||
    ![
      policy.minMove,
      policy.minIncrementalYield,
      policy.minNetGain,
      policy.maxGasCost,
      policy.capacityBuffer,
      policy.liquidityBuffer,
      policy.rateToleranceRay,
    ].every(uint) ||
    policy.minMove === 0n ||
    policy.minMove > policy.limits.maxMove ||
    policy.maxGasCost === 0n ||
    policy.rateToleranceRay > YIELD_RAY / BPS ||
    !policy.reviewedModels.every((pin) => address(pin.address) && hash(pin.runtimeHash))
  )
    return 'INVALID_INPUT'
  if (
    snapshot.block.chainId !== 56 ||
    snapshot.identityVerified !== true ||
    !equal(snapshot.vault, policy.vault) ||
    !equal(snapshot.controller, policy.controller) ||
    !equal(snapshot.policyHash, policy.policyHash) ||
    !limitKeys.every((key) => snapshot.limits[key] === policy.limits[key])
  )
    return 'IDENTITY_MISMATCH'
  const block = snapshot.block
  if (
    !uint(block.number) ||
    !hash(block.hash) ||
    !integer(block.timestamp) ||
    block.finalized !== true ||
    block.canonical !== true
  )
    return 'INCONSISTENT_SNAPSHOT'
  if (block.timestamp > now || now - block.timestamp > policy.maxSnapshotAgeSeconds)
    return 'STALE_SNAPSHOT'
  if (
    ![
      snapshot.nonce,
      snapshot.fundedPrincipal,
      snapshot.turnover,
      snapshot.cumulativeLoss,
      snapshot.managedIdle,
      snapshot.actualIdle,
      snapshot.managedVenusShares,
      snapshot.managedAaveScaled,
    ].every(uint) ||
    !positive(snapshot.expiresAt) ||
    !integer(snapshot.lastExecutionAt) ||
    !integer(snapshot.minInterval) ||
    snapshot.minInterval > 30 * 86_400 ||
    !positive(snapshot.maxDeadlineDelay) ||
    snapshot.maxDeadlineDelay > 3_600 ||
    snapshot.fundedPrincipal > policy.limits.maxPrincipal ||
    snapshot.turnover > policy.limits.maxTurnover ||
    snapshot.cumulativeLoss > policy.limits.maxCumulativeLoss ||
    snapshot.actualIdle < snapshot.managedIdle ||
    snapshot.lastExecutionAt > block.timestamp ||
    typeof snapshot.paused !== 'boolean'
  )
    return 'INCONSISTENT_SNAPSHOT'
  for (const id of VENUES) {
    const venue = snapshot.venues[id]
    if (
      venue.id !== id ||
      venue.identityVerified !== true ||
      venue.decimals !== 18 ||
      !equal(venue.underlying, YIELD_CANONICAL.underlying) ||
      !equal(venue.market, YIELD_CANONICAL[id]) ||
      !equal(venue.receipt, id === 'venus' ? YIELD_CANONICAL.venus : YIELD_CANONICAL.aaveReceipt)
    )
      return 'IDENTITY_MISMATCH'
    if (
      venue.blockNumber !== block.number ||
      !equal(venue.blockHash, block.hash) ||
      ![
        venue.cash,
        venue.virtualCash,
        venue.debt,
        venue.reserves,
        venue.unbacked,
        venue.stableDebt,
        venue.reserveFactorWad,
        venue.totalSupplied,
        venue.accruedTreasuryAssets,
        venue.withdrawalFeeWad,
        venue.receiptRate,
        venue.actualReceiptBalance,
        venue.observedSupplyRate,
      ].every(uint) ||
      !(venue.supplyCap === null || uint(venue.supplyCap)) ||
      (id === 'venus' && venue.supplyCap === null) ||
      venue.withdrawalFeeWad >= YIELD_WAD ||
      venue.reserveFactorWad > YIELD_WAD ||
      venue.receiptRate === 0n ||
      (id === 'aave' &&
        (venue.receiptRate < YIELD_RAY ||
          venue.reserves !== 0n ||
          venue.withdrawalFeeWad !== 0n)) ||
      (id === 'venus' && venue.virtualCash !== venue.cash) ||
      ![
        venue.active,
        venue.listed,
        venue.supplyPaused,
        venue.withdrawPaused,
        venue.frozen,
        venue.legacy,
      ].every((v) => typeof v === 'boolean')
    )
      return 'INCONSISTENT_SNAPSHOT'
  }
  if (
    snapshot.managedVenusShares > snapshot.venues.venus.actualReceiptBalance ||
    snapshot.managedAaveScaled > snapshot.venues.aave.actualReceiptBalance
  )
    return 'INCONSISTENT_SNAPSHOT'
  return null
}

function positions(s: YieldSnapshot): Record<YieldVenueId, bigint> {
  return {
    idle: s.managedIdle,
    venus: (s.managedVenusShares * s.venues.venus.receiptRate) / YIELD_WAD,
    aave: (s.managedAaveScaled * s.venues.aave.receiptRate) / YIELD_RAY,
  }
}

function withdrawable(v: YieldVenueSnapshot, held: bigint, buffer: bigint): bigint {
  if (!v.listed || !v.active || v.withdrawPaused) return 0n
  return minBig(held, maxBig(0n, minBig(v.cash, v.virtualCash) - buffer))
}

function depositRoom(
  v: YieldVenueSnapshot,
  held: bigint,
  exposure: bigint,
  buffer: bigint,
): bigint {
  if (!v.listed || !v.active || v.supplyPaused || v.frozen || v.legacy) return 0n
  const capRoom =
    v.supplyCap === null
      ? 2n ** 255n
      : maxBig(0n, v.supplyCap - v.totalSupplied - v.accruedTreasuryAssets - buffer)
  return minBig(capRoom, maxBig(0n, exposure - held))
}

function quantum(v: YieldVenueSnapshot): bigint {
  return ceilDiv(v.receiptRate, v.id === 'venus' ? YIELD_WAD : YIELD_RAY)
}

function lossAllowed(loss: bigint, amount: bigint, s: YieldSnapshot): boolean {
  return (
    loss <= s.limits.maxLossPerMove &&
    loss * BPS <= amount * BigInt(s.limits.maxLossBps) &&
    s.cumulativeLoss + loss <= s.limits.maxCumulativeLoss
  )
}

function makeCandidate(
  source: YieldVenueId,
  destination: YieldVenueId,
  amount: bigint,
  s: YieldSnapshot,
  policy: YieldPlannerPolicy,
  held: Record<YieldVenueId, bigint>,
  rates: Record<'venus' | 'aave', bigint>,
  reserve: bigint,
  horizonSeconds: number,
): YieldCandidate | null {
  if (amount <= 0n || amount > s.limits.maxMove || amount > held[source]) return null
  const sourceLoss =
    source === 'idle' ? 0n : ceilDiv(amount * s.venues[source].withdrawalFeeWad, YIELD_WAD)
  const sourceRounding = source === 'idle' ? 0n : quantum(s.venues[source])
  const destinationRounding = destination === 'idle' ? 0n : quantum(s.venues[destination])
  const roundingLoss = sourceRounding + destinationRounding
  const expectedLoss = sourceLoss + roundingLoss
  const expectedMoved = amount - sourceLoss
  if (expectedMoved <= expectedLoss || !lossAllowed(expectedLoss, amount, s)) return null
  if (destination !== 'idle' && s.turnover + expectedMoved > s.limits.maxTurnover) return null
  const after = { ...held }
  after[source] = maxBig(0n, after[source] - amount - sourceRounding)
  after[destination] += expectedMoved - destinationRounding
  if (
    destination !== 'idle' &&
    (after.idle < reserve ||
      after.venus > s.limits.maxVenusExposure ||
      after.aave > s.limits.maxAaveExposure)
  )
    return null
  let incrementalNumerator = 0n
  for (const id of VENUES) {
    const cashDelta = source === id ? -amount : destination === id ? expectedMoved : 0n
    const rate = supplyRateAfter(s.venues[id], cashDelta, s.block, policy)
    if (rate === null) return null
    incrementalNumerator += after[id] * rate - held[id] * rates[id]
  }
  // Signed division would round a negative loss towards zero: round negative projections
  // away from zero so a small projected drag cannot become a zero-cost candidate.
  const n = incrementalNumerator * BigInt(horizonSeconds)
  const denominator = YIELD_RAY * YIELD_YEAR
  const incrementalYield = n < 0n ? -ceilDiv(-n, denominator) : n / denominator
  return {
    source,
    destination,
    assets: amount,
    expectedMoved,
    expectedLoss,
    incrementalYield,
    horizonSeconds,
    reserveRestoration: held.idle < reserve && destination === 'idle',
  }
}

/** Pure planning only. This never calls RPC, grants authority, changes a watch, or sends a transaction.
 * Returned nextState must be persisted under the same strategy lease/CAS as other observations.
 * Execution admission must independently reserve this nonce before broadcasting anything. */
export function decideYield(
  snapshot: YieldSnapshot,
  policy: YieldPlannerPolicy,
  state: YieldPlannerState,
  nowSeconds: number,
): YieldDecision {
  const resetState = (): YieldPlannerState =>
    state?.pendingNonce === undefined ? {} : { pendingNonce: state.pendingNonce }
  const wait = (
    code: YieldReason,
    reason: string,
    candidates?: YieldCandidate[],
  ): YieldDecision => ({
    act: false,
    code,
    reason,
    nextState: resetState(),
    ...(candidates ? { candidates } : {}),
  })
  try {
    const invalid = validate(snapshot, policy, nowSeconds)
    if (invalid)
      return wait(
        invalid,
        'Snapshot or reviewed policy failed validation; no allocation is permitted.',
      )
    if (
      state.lastObservation &&
      (state.lastObservation.blockNumber > snapshot.block.number ||
        (state.lastObservation.blockNumber === snapshot.block.number &&
          !equal(state.lastObservation.blockHash, snapshot.block.hash)) ||
        state.lastObservation.nonce > snapshot.nonce)
    )
      return wait(
        'INCONSISTENT_SNAPSHOT',
        'The finalized cursor or operation nonce moved backwards or changed hash.',
      )
    if (state.pendingNonce !== undefined)
      return wait(
        'PENDING_EXECUTION',
        'A prior execution is unresolved; reconcile its exact transaction before planning again.',
      )
    if (snapshot.paused) return wait('PAUSED', 'The owner has not enabled this vault.')
    if (nowSeconds >= snapshot.expiresAt)
      return wait('EXPIRED', 'The immutable policy has expired; owner recovery remains separate.')
    if (
      snapshot.lastExecutionAt > 0 &&
      nowSeconds < snapshot.lastExecutionAt + snapshot.minInterval
    ) {
      return wait('COOLDOWN', 'The onchain minimum interval has not elapsed.')
    }
    const rates = {} as Record<'venus' | 'aave', bigint>
    for (const id of VENUES) {
      const venue = snapshot.venues[id]
      const modelRate = supplyRateAfter(venue, 0n, snapshot.block, policy)
      const observed = normalizeYieldRate(venue.observedSupplyRate, venue, snapshot.block, policy)
      if (modelRate === null || observed === null)
        return wait(
          'RATE_MODEL_UNSUPPORTED',
          'A venue model or rate clock is not explicitly reviewed and supported.',
        )
      if (maxBig(modelRate, observed) - minBig(modelRate, observed) > policy.rateToleranceRay) {
        return wait(
          'RATE_MISMATCH',
          'The reviewed model does not reproduce the current onchain supply rate.',
        )
      }
      rates[id] = modelRate
    }
    const held = positions(snapshot)
    const nav = held.idle + held.venus + held.aave
    const reserve = maxBig(snapshot.limits.minIdle, ceilDiv(nav * BigInt(policy.minIdleBps), BPS))
    const sources: Record<YieldVenueId, bigint> = {
      idle: maxBig(0n, held.idle - reserve),
      venus: withdrawable(snapshot.venues.venus, held.venus, policy.liquidityBuffer),
      aave: withdrawable(snapshot.venues.aave, held.aave, policy.liquidityBuffer),
    }
    const rooms = {
      venus: depositRoom(
        snapshot.venues.venus,
        held.venus,
        snapshot.limits.maxVenusExposure,
        policy.capacityBuffer,
      ),
      aave: depositRoom(
        snapshot.venues.aave,
        held.aave,
        snapshot.limits.maxAaveExposure,
        policy.capacityBuffer,
      ),
    }
    const candidates: YieldCandidate[] = []
    // Do not justify gas with income projected beyond this authority's remaining lifetime.
    const horizonSeconds = Math.min(policy.horizonSeconds, snapshot.expiresAt - nowSeconds)
    for (const source of ['idle', ...VENUES] as const) {
      for (const destination of ['idle', ...VENUES] as const) {
        if (source === destination || (held.idle < reserve && destination !== 'idle')) continue
        // Ordinary yield allocation never withdraws to zero-yield idle just to generate activity.
        if (destination === 'idle' && held.idle >= reserve) continue
        const room =
          destination === 'idle'
            ? maxBig(
                policy.minMove,
                ceilDiv(
                  (reserve - held.idle) * YIELD_WAD,
                  YIELD_WAD - (source === 'idle' ? 0n : snapshot.venues[source].withdrawalFeeWad),
                ),
              )
            : minBig(rooms[destination], snapshot.limits.maxTurnover - snapshot.turnover)
        const maximum = minBig(snapshot.limits.maxMove, sources[source], room)
        if (
          maximum < policy.minMove &&
          !(destination === 'idle' && maximum > 0n && maximum === room)
        )
          continue
        // Bounded search, not a claim of globally optimal allocation. A maximum-sized
        // deposit can depress its destination rate enough that a smaller move is better.
        const amounts =
          destination === 'idle'
            ? [maximum]
            : [...new Set([maximum, maximum / 2n, maximum / 4n, policy.minMove])].filter(
                (amount) => amount >= policy.minMove && amount <= maximum,
              )
        for (const amount of amounts) {
          const candidate = makeCandidate(
            source,
            destination,
            amount,
            snapshot,
            policy,
            held,
            rates,
            reserve,
            horizonSeconds,
          )
          if (candidate) candidates.push(candidate)
        }
      }
    }
    if (candidates.length === 0)
      return wait(
        held.idle < reserve ? 'RESERVE_UNAVAILABLE' : 'NO_CAPACITY',
        'No move satisfies liquidity, full destination capacity, reserve, exposure, turnover and execution-loss limits.',
      )
    const useful = candidates.filter(
      (c) => c.reserveRestoration || c.incrementalYield >= policy.minIncrementalYield,
    )
    if (useful.length === 0)
      return wait(
        'NO_NET_BENEFIT',
        'Post-move portfolio income does not meet the reviewed improvement threshold.',
      )
    const price = snapshot.nativePrice
    if (
      price?.verified !== true ||
      price.blockNumber !== snapshot.block.number ||
      !equal(price.blockHash, snapshot.block.hash) ||
      !uint(price.usdtPerBnbRay) ||
      price.usdtPerBnbRay === 0n ||
      !integer(price.updatedAt) ||
      price.updatedAt > snapshot.block.timestamp ||
      nowSeconds - price.updatedAt > policy.maxPriceAgeSeconds
    ) {
      return wait(
        'PRICE_UNAVAILABLE',
        'Fresh verified BNB/USDT pricing is required to include gas costs.',
      )
    }
    const priced: (YieldCandidate & { gasCost: bigint; netGain: bigint; deadline: number })[] = []
    let missingQuote = false
    let expensive = false
    for (const candidate of useful) {
      const matching = snapshot.executionQuotes.filter(
        (q) =>
          q.source === candidate.source &&
          q.destination === candidate.destination &&
          q.assets === candidate.assets &&
          q.nonce === snapshot.nonce &&
          q.blockNumber === snapshot.block.number &&
          equal(q.blockHash, snapshot.block.hash) &&
          equal(q.vault, snapshot.vault) &&
          equal(q.policyHash, snapshot.policyHash) &&
          q.minReceived === candidate.expectedMoved &&
          integer(q.deadline) &&
          q.deadline > nowSeconds &&
          q.deadline <= snapshot.expiresAt &&
          q.deadline - nowSeconds <= snapshot.maxDeadlineDelay &&
          q.path === 'manager-delegation' &&
          q.simulated === true,
      )
      if (
        matching.length !== 1 ||
        ![matching[0]?.gasUnits, matching[0]?.gasPriceWei, matching[0]?.unwindGasUnits].every(
          (v) => uint(v) && v > 0n,
        )
      ) {
        missingQuote = true
        continue
      }
      const q = matching[0]
      if (!q) {
        missingQuote = true
        continue
      }
      const gasCost = fullGasCost(
        q.gasUnits + q.unwindGasUnits,
        q.gasPriceWei,
        price.usdtPerBnbRay,
        policy.gasBufferBps,
      )
      if (gasCost > policy.maxGasCost) {
        expensive = true
        continue
      }
      const netGain = candidate.incrementalYield - gasCost - candidate.expectedLoss
      if (!candidate.reserveRestoration && netGain < policy.minNetGain) continue
      priced.push({ ...candidate, gasCost, netGain, deadline: q.deadline })
    }
    // Do not choose a lower-ranked route while a useful alternative lacks its full quote.
    if (missingQuote)
      return wait(
        'QUOTE_REQUIRED',
        'Quote each candidate through the full manager transaction at this block and nonce.',
        useful,
      )
    if (!priced.length)
      return wait(
        expensive ? 'GAS_LIMIT' : 'NO_NET_BENEFIT',
        'Expected improvement does not cover full execution/unwind gas, execution loss and the required margin.',
      )
    priced.sort((a, b) =>
      a.netGain === b.netGain
        ? `${a.source}:${a.destination}`.localeCompare(`${b.source}:${b.destination}`)
        : a.netGain > b.netGain
          ? -1
          : 1,
    )
    const chosen = priced[0]
    if (!chosen) return wait('NO_CAPACITY', 'No candidate remains.')
    const key = `${chosen.source}:${chosen.destination}`
    const previous = state.lastObservation
    let count = 1
    if (
      previous &&
      uint(previous.blockNumber) &&
      hash(previous.blockHash) &&
      integer(previous.timestamp) &&
      positive(previous.count) &&
      previous.count <= policy.requiredObservations &&
      previous.nonce === snapshot.nonce &&
      previous.candidate === key &&
      previous.timestamp <= snapshot.block.timestamp &&
      snapshot.block.timestamp - previous.timestamp <= policy.maxObservationGapSeconds
    ) {
      if (
        previous.blockNumber === snapshot.block.number &&
        equal(previous.blockHash, snapshot.block.hash)
      )
        count = previous.count
      else if (
        previous.blockNumber < snapshot.block.number &&
        snapshot.block.timestamp - previous.timestamp >= policy.minObservationSeconds
      )
        count = previous.count + 1
      else
        return {
          act: false,
          code: 'HYSTERESIS',
          reason: 'Waiting for an independently spaced observation.',
          nextState: state,
        }
    }
    const nextState: YieldPlannerState = {
      lastObservation: {
        blockNumber: snapshot.block.number,
        blockHash: snapshot.block.hash,
        timestamp: snapshot.block.timestamp,
        candidate: key,
        count: Math.min(count, policy.requiredObservations),
        nonce: snapshot.nonce,
      },
    }
    if (!chosen.reserveRestoration && count < policy.requiredObservations)
      return {
        act: false,
        code: 'HYSTERESIS',
        reason: 'The same net-beneficial route must persist across independent fresh observations.',
        nextState,
      }
    return {
      act: true,
      code: 'READY',
      reason: chosen.reserveRestoration
        ? 'Restore the reviewed idle reserve within the same-asset loss and gas limits.'
        : 'Post-move portfolio yield exceeds full gas, conservative execution loss and the reviewed margin.',
      nextState,
      plan: {
        ...chosen,
        vault: snapshot.vault,
        policyHash: snapshot.policyHash,
        expectedNonce: snapshot.nonce,
        quoteBlockNumber: snapshot.block.number,
        quoteBlockHash: snapshot.block.hash,
        minReceived: chosen.expectedMoved,
      },
    }
  } catch {
    return wait('INVALID_INPUT', 'Incomplete or malformed planning evidence; refusing to guess.')
  }
}
