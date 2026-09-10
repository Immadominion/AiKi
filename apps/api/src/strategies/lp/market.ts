// SPDX-License-Identifier: GPL-2.0-or-later
// Retained history, wrapped cumulative subtraction and harmonic liquidity follow Pancake OracleLibrary
// at 986847948755cba528324d41be19480731c36c2a and the reviewed onchain PancakeOracle.sol.
import { type Hex, keccak256, parseAbi } from 'viem'
import { MAX_SQRT_RATIO, MAX_TICK, MIN_TICK, sqrtRatioAtTick } from '../grid/math.js'
import { nonzeroHash } from '../operation.js'
import {
  isVerifiedStrategySnapshot,
  type StrategySnapshotReader,
  type VerifiedStrategySnapshot,
} from '../snapshot.js'

const POOL_ABI = parseAbi([
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)',
  'function observations(uint256 index) view returns (uint32 blockTimestamp,int56 tickCumulative,uint160 secondsPerLiquidityCumulativeX128,bool initialized)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)',
])
const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)',
])
const issued = new WeakSet<object>()
const verified = Symbol('verified-lp-pool-state')
export interface VerifiedLPPoolState {
  readonly [verified]: true
  /** Exact original proof, not merely equal fields from another snapshot. */
  readonly snapshot: VerifiedStrategySnapshot
  readonly pool: Hex
  readonly runtimeCodeHash: Hex
  readonly spot: number
  readonly twap: number
  readonly sqrtPriceX96: bigint
  readonly liquidity: bigint
  readonly harmonicLiquidity: bigint
  readonly window: number
}
export function isVerifiedLPPoolState(value: unknown): value is VerifiedLPPoolState {
  return typeof value === 'object' && value !== null && issued.has(value)
}
const fail = (): never => {
  throw new Error('Unverified LP pool state.')
}
const u = (value: unknown, bits: number): bigint =>
  typeof value === 'bigint' && value >= 0n && value < 1n << BigInt(bits) ? value : fail()
const i = (value: unknown, bits: number): bigint =>
  typeof value === 'bigint' && value >= -(1n << BigInt(bits - 1)) && value < 1n << BigInt(bits - 1)
    ? value
    : fail()
const n = (value: unknown, min: number, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fail()
const tuple = (value: unknown, length: number): unknown[] =>
  Array.isArray(value) && value.length === length ? value : fail()
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** No spot fallback or quote from a different block. This is not a post-removal swap simulation. */
export async function readLPPoolState(
  snapshot: VerifiedStrategySnapshot,
  config: { runtimeCodeHash: Hex },
  reader: StrategySnapshotReader,
): Promise<
  { status: 'verified'; market: VerifiedLPPoolState } | { status: 'blocked'; reason: string }
> {
  try {
    if (
      !isVerifiedStrategySnapshot(snapshot) ||
      snapshot.state.kind !== 'lp' ||
      !nonzeroHash(config?.runtimeCodeHash)
    )
      return fail()
    const runtimeCodeHash = config.runtimeCodeHash.toLowerCase() as Hex
    const { protocol, limits } = snapshot.state,
      { block } = snapshot
    if ((await reader.getChainId()) !== 56) return fail()
    const code = await reader.getBytecode({ address: protocol.pool, blockNumber: block.number })
    if (!code || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || keccak256(code) !== runtimeCodeHash)
      return fail()
    const read = (functionName: string, args?: readonly unknown[]) =>
      reader.readContract({
        address: protocol.pool,
        abi: POOL_ABI,
        functionName,
        ...(args ? { args } : {}),
        blockNumber: block.number,
      })
    const [factory, token0, token1, fee, tickSpacing, slotValue, liquidityValue, registeredPool] =
      await Promise.all([
        read('factory'),
        read('token0'),
        read('token1'),
        read('fee'),
        read('tickSpacing'),
        read('slot0'),
        read('liquidity'),
        reader.readContract({
          address: protocol.factory,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [protocol.token0, protocol.token1, protocol.fee],
          blockNumber: block.number,
        }),
      ])
    if (
      !same(factory, protocol.factory) ||
      !same(token0, protocol.token0) ||
      !same(token1, protocol.token1) ||
      fee !== protocol.fee ||
      tickSpacing !== protocol.tickSpacing ||
      !same(registeredPool, protocol.pool)
    )
      return fail()
    const slot = tuple(slotValue, 7)
    const sqrtPriceX96 = u(slot[0], 160),
      spot = n(slot[1], MIN_TICK, MAX_TICK - 1)
    const index = n(slot[2], 0, 65535),
      cardinality = n(slot[3], 1, 65535)
    n(slot[4], cardinality, 65535)
    n(slot[5], 0, 0xffff_ffff)
    const liquidity = u(liquidityValue, 128)
    if (
      slot[6] !== true ||
      index >= cardinality ||
      sqrtPriceX96 >= MAX_SQRT_RATIO ||
      sqrtPriceX96 < sqrtRatioAtTick(spot) ||
      sqrtPriceX96 > sqrtRatioAtTick(spot + 1) ||
      liquidity < limits.minPoolLiquidity ||
      limits.minPoolLiquidity === 0n ||
      limits.twapWindow <= 0
    )
      return fail()
    let oldest = tuple(await read('observations', [(index + 1) % cardinality]), 4)
    if (oldest[3] === false) oldest = tuple(await read('observations', [0]), 4)
    const timestamp = n(oldest[0], 0, 0xffff_ffff)
    i(oldest[1], 56)
    u(oldest[2], 160)
    if (
      oldest[3] !== true ||
      BigInt.asUintN(32, block.timestamp - BigInt(timestamp)) < BigInt(limits.twapWindow)
    )
      return fail()
    const observation = tuple(await read('observe', [[limits.twapWindow, 0]]), 2)
    const ticks = tuple(observation[0], 2),
      cumulatives = tuple(observation[1], 2)
    const tickDelta = BigInt.asIntN(56, i(ticks[1], 56) - i(ticks[0], 56))
    const liquidityDelta = BigInt.asUintN(160, u(cumulatives[1], 160) - u(cumulatives[0], 160))
    const window = BigInt(limits.twapWindow)
    let mean = tickDelta / window
    if (tickDelta < 0n && tickDelta % window !== 0n) mean--
    if (mean < BigInt(MIN_TICK) || mean > BigInt(MAX_TICK) || liquidityDelta === 0n) return fail()
    const twap = Number(mean)
    const harmonicLiquidity = (window * ((1n << 160n) - 1n)) / (liquidityDelta << 32n)
    if (
      harmonicLiquidity < limits.minPoolLiquidity ||
      harmonicLiquidity >= 1n << 128n ||
      Math.abs(spot - twap) > limits.maxDeviationTicks
    )
      return fail()
    const canonical = (await reader.getBlock({ blockNumber: block.number })) as Record<
      string,
      unknown
    > | null
    if (
      !canonical ||
      canonical.number !== block.number ||
      !same(canonical.hash, block.hash) ||
      canonical.timestamp !== block.timestamp ||
      (await reader.getChainId()) !== 56
    )
      return fail()
    const market: VerifiedLPPoolState = Object.freeze({
      [verified]: true as const,
      snapshot,
      pool: protocol.pool,
      runtimeCodeHash,
      spot,
      twap,
      sqrtPriceX96,
      liquidity,
      harmonicLiquidity,
      window: limits.twapWindow,
    })
    issued.add(market)
    return { status: 'verified', market }
  } catch {
    return {
      status: 'blocked',
      reason:
        'The reviewed same-block LP pool, retained TWAP history or remaining liquidity could not be verified.',
    }
  }
}
