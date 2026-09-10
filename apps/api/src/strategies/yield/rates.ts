import type { YieldBlock, YieldPlannerPolicy, YieldVenueSnapshot } from './types.js'

export const YIELD_WAD = 10n ** 18n
export const YIELD_RAY = 10n ** 27n
export const YIELD_YEAR = 365n * 24n * 60n * 60n
const BPS = 10_000n
type YieldRatePolicy = Pick<YieldPlannerPolicy, 'reviewedModels' | 'minClockSampleSeconds'>

export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b
export const minBig = (...values: bigint[]): bigint => values.reduce((a, b) => (a < b ? a : b))
export const maxBig = (...values: bigint[]): bigint => values.reduce((a, b) => (a > b ? a : b))

export function normalizeYieldRate(
  rate: bigint,
  venue: YieldVenueSnapshot,
  block: YieldBlock,
  policy: YieldRatePolicy,
): bigint | null {
  const model = venue.model
  if (
    !model ||
    !['reviewed-two-slope', 'venus-two-kinks', 'aave-v3-two-slope'].includes(model.kind) ||
    model.verified !== true ||
    rate < 0n
  )
    return null
  if (
    !policy.reviewedModels.some(
      (pin) =>
        pin.address.toLowerCase() === model.address.toLowerCase() &&
        pin.runtimeHash.toLowerCase() === model.runtimeHash.toLowerCase(),
    )
  )
    return null
  const clock = model.clock
  if (
    model.kind === 'venus-two-kinks' &&
    (venue.id !== 'venus' || clock.kind !== 'per-block' || clock.scale !== YIELD_WAD)
  )
    return null
  if (
    model.kind === 'aave-v3-two-slope' &&
    (venue.id !== 'aave' || clock.kind !== 'annual' || clock.scale !== YIELD_RAY)
  )
    return null
  if (clock.scale !== YIELD_WAD && clock.scale !== YIELD_RAY) return null
  if (clock.kind === 'annual') return (rate * YIELD_RAY) / clock.scale
  if (clock.verifiedOnchain !== true) return null
  if (clock.kind === 'per-second') return (rate * YIELD_RAY * YIELD_YEAR) / clock.scale
  if (clock.kind !== 'per-block' || !Number.isSafeInteger(clock.sampleStartTimestamp)) return null
  const seconds = block.timestamp - clock.sampleStartTimestamp
  const blocks = block.number - clock.sampleStartBlock
  if (seconds < policy.minClockSampleSeconds || seconds > 86_400 || blocks <= 0n) return null
  // Measured clock from the same chain ending at this exact snapshot, never a hardcoded
  // BSC blocks/year constant. A future clock/model change requires a new verified snapshot.
  return (rate * YIELD_RAY * YIELD_YEAR * blocks) / (clock.scale * BigInt(seconds))
}

/** Reprice the ENTIRE remaining position at the proposed post-move utilization. */
export function supplyRateAfter(
  venue: YieldVenueSnapshot,
  cashDelta: bigint,
  block: YieldBlock,
  policy: YieldRatePolicy,
): bigint | null {
  const model = venue.model
  if (
    !model ||
    venue.unbacked !== 0n ||
    venue.stableDebt !== 0n ||
    typeof venue.deficit !== 'bigint' ||
    venue.deficit < 0n ||
    (model.kind !== 'aave-v3-two-slope' && venue.deficit !== 0n) ||
    venue.reserveFactorWad < 0n ||
    venue.reserveFactorWad > YIELD_WAD ||
    model.baseBorrowRate < 0n
  )
    return null
  const cash = (venue.id === 'aave' ? venue.virtualCash : venue.cash) + cashDelta
  const denominator = cash + venue.debt - (venue.id === 'venus' ? venue.reserves : 0n)
  if (
    cash < 0n ||
    denominator < 0n ||
    (denominator === 0n && venue.debt > 0n) ||
    venue.debt < 0n ||
    venue.reserves < 0n
  )
    return null
  let utilization = denominator === 0n ? 0n : (venue.debt * YIELD_WAD) / denominator
  if (model.kind === 'venus-two-kinks') {
    if (
      model.kink1Wad <= 0n ||
      model.kink2Wad <= model.kink1Wad ||
      model.kink2Wad >= YIELD_WAD ||
      model.baseRate2PerBlock < 0n ||
      model.blocksPerYear <= 0n ||
      model.rate1 !==
        (model.kink1Wad * model.multiplierPerBlock) / YIELD_WAD + model.baseBorrowRate ||
      model.rate2 !==
        ((model.kink2Wad - model.kink1Wad) * model.multiplier2PerBlock) / YIELD_WAD +
          model.baseRate2PerBlock
    )
      return null
    utilization = minBig(utilization, YIELD_WAD)
    const borrow = maxBig(
      0n,
      utilization < model.kink1Wad
        ? (utilization * model.multiplierPerBlock) / YIELD_WAD + model.baseBorrowRate
        : utilization < model.kink2Wad
          ? model.rate1 +
            ((utilization - model.kink1Wad) * model.multiplier2PerBlock) / YIELD_WAD +
            model.baseRate2PerBlock
          : model.rate1 +
            model.rate2 +
            ((utilization - model.kink2Wad) * model.jumpMultiplierPerBlock) / YIELD_WAD,
    )
    const rateToPool = (borrow * (YIELD_WAD - venue.reserveFactorWad)) / YIELD_WAD
    const annual = normalizeYieldRate((utilization * rateToPool) / YIELD_WAD, venue, block, policy)
    return annual !== null && annual <= 1_000n * YIELD_RAY ? annual : null
  }
  if (
    utilization > YIELD_WAD ||
    model.kinkWad <= 0n ||
    model.kinkWad >= YIELD_WAD ||
    model.slopeBelowKink < 0n ||
    model.slopeAboveKink < 0n
  )
    return null
  if (model.kind === 'aave-v3-two-slope') {
    if (venue.reserveFactorWad % (YIELD_WAD / BPS) !== 0n) return null
    const rayMul = (a: bigint, b: bigint) => (a * b + YIELD_RAY / 2n) / YIELD_RAY
    const rayDiv = (a: bigint, b: bigint) => (a * YIELD_RAY + b / 2n) / b
    const use = denominator === 0n ? 0n : rayDiv(venue.debt, denominator)
    // Aave ReserveLogic passes reserve.deficit as the model's `unbacked` input.
    // It dilutes supply usage only; including it in borrow usage changes the curve.
    const supplyUse = venue.debt === 0n ? 0n : rayDiv(venue.debt, denominator + venue.deficit)
    const kink = model.kinkWad * (YIELD_RAY / YIELD_WAD)
    const borrow =
      model.baseBorrowRate +
      (use > kink
        ? model.slopeBelowKink + rayMul(model.slopeAboveKink, rayDiv(use - kink, YIELD_RAY - kink))
        : rayDiv(rayMul(model.slopeBelowKink, use), kink))
    const factorBps = BPS - (venue.reserveFactorWad * BPS) / YIELD_WAD
    const nativeSupplyRate = (rayMul(borrow, supplyUse) * factorBps + BPS / 2n) / BPS
    const annual = normalizeYieldRate(nativeSupplyRate, venue, block, policy)
    return annual !== null && annual <= 1_000n * YIELD_RAY ? annual : null
  }
  const nativeBorrowRate =
    model.baseBorrowRate +
    (utilization <= model.kinkWad
      ? (model.slopeBelowKink * utilization) / model.kinkWad
      : model.slopeBelowKink +
        (model.slopeAboveKink * (utilization - model.kinkWad)) / (YIELD_WAD - model.kinkWad))
  const nativeSupplyRate =
    (((nativeBorrowRate * utilization) / YIELD_WAD) * (YIELD_WAD - venue.reserveFactorWad)) /
    YIELD_WAD
  const annual = normalizeYieldRate(nativeSupplyRate, venue, block, policy)
  return annual !== null && annual <= 1_000n * YIELD_RAY ? annual : null
}

export function fullGasCost(
  gasUnits: bigint,
  gasPriceWei: bigint,
  usdtPerBnbRay: bigint,
  bufferBps: number,
): bigint {
  // USDT and BNB both have 18 decimals. Ray is only the price ratio's scale.
  return ceilDiv(
    gasUnits * gasPriceWei * usdtPerBnbRay * (BPS + BigInt(bufferBps)),
    YIELD_RAY * BPS,
  )
}
