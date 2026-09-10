import { type Hex, keccak256, parseAbi } from 'viem'
import {
  isVerifiedStrategySnapshot,
  type StrategySnapshotReader,
  type VerifiedStrategySnapshot,
} from '../snapshot.js'
import { MAX_SQRT_RATIO, MAX_TICK, MIN_TICK, sqrtRatioAtTick } from './math.js'

const POOL_ABI = parseAbi([
  'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
  'function liquidity() view returns(uint128)',
  'function observations(uint256) view returns(uint32,int56,uint160,bool)',
  'function observe(uint32[]) view returns(int56[],uint160[])',
])
const TOKEN_ABI = parseAbi(['function allowance(address,address) view returns(uint256)'])
const issued = new WeakMap<object, VerifiedStrategySnapshot>()
export interface VerifiedGridMarketSnapshot {
  readonly blockNumber: bigint
  readonly blockHash: Hex
  readonly pool: Hex
  readonly spot: number
  readonly twap: number
  readonly sqrtPriceX96: bigint
  readonly currentLiquidity: bigint
  readonly harmonicLiquidity: bigint
  readonly allowance0: bigint
  readonly allowance1: bigint
}
export function isVerifiedGridMarketSnapshot(
  value: unknown,
  snapshot: VerifiedStrategySnapshot,
): value is VerifiedGridMarketSnapshot {
  return !!value && typeof value === 'object' && issued.get(value) === snapshot
}
const fail = (): never => {
  throw new Error('Unverified grid market state.')
}
const uint = (value: unknown, bits: number): bigint =>
  typeof value === 'bigint' && value >= 0n && value < 1n << BigInt(bits) ? value : fail()
const small = (value: unknown, bits: number, signed = false): number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= (signed ? -(2 ** (bits - 1)) : 0) &&
  value < 2 ** (signed ? bits - 1 : bits)
    ? value
    : fail()
const array = (value: unknown, length: number): unknown[] =>
  Array.isArray(value) && value.length === length ? value : fail()
const int56 = (value: unknown): bigint =>
  typeof value === 'bigint' && value >= -(1n << 55n) && value < 1n << 55n ? value : fail()

/** Reproduces PancakeOracle.checkedState at the SAME finalized block as custody/rungs.
 * No spot fallback, synthetic history, state overrides or latest reads. Proof issuance is
 * tied to the exact immutable snapshot object, not merely caller-provided identity flags. */
export async function readGridMarketSnapshot(
  snapshot: VerifiedStrategySnapshot,
  reader: StrategySnapshotReader,
): Promise<
  { status: 'verified'; market: VerifiedGridMarketSnapshot } | { status: 'blocked'; reason: string }
> {
  try {
    if (
      !isVerifiedStrategySnapshot(snapshot) ||
      snapshot.state.kind !== 'grid' ||
      (await reader.getChainId()) !== 56
    )
      return fail()
    const state = snapshot.state,
      p = state.policy,
      pool = state.protocol.pool
    const read = (functionName: string, args?: readonly unknown[]) =>
      reader.readContract({
        address: pool,
        abi: POOL_ABI,
        functionName,
        ...(args ? { args } : {}),
        blockNumber: snapshot.block.number,
      })
    const code = await reader.getBytecode({ address: pool, blockNumber: snapshot.block.number })
    if (
      typeof code !== 'string' ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(code) ||
      keccak256(code) !== state.protocol.codeHashes.pool
    )
      return fail()
    const slot = array(await read('slot0'), 7)
    const sqrtPriceX96 = uint(slot[0], 160),
      spot = small(slot[1], 24, true)
    const index = small(slot[2], 16),
      cardinality = small(slot[3], 16)
    small(slot[4], 16)
    small(slot[5], 32)
    if (
      slot[6] !== true ||
      cardinality === 0 ||
      index >= cardinality ||
      spot < MIN_TICK ||
      spot >= MAX_TICK ||
      sqrtPriceX96 >= MAX_SQRT_RATIO ||
      sqrtPriceX96 < sqrtRatioAtTick(spot) ||
      sqrtPriceX96 > sqrtRatioAtTick(spot + 1) ||
      p.twapWindow < 60 ||
      p.twapWindow > 86400 ||
      p.minLiquidity <= 0n
    )
      return fail()
    const currentLiquidity = uint(await read('liquidity'), 128)
    let oldest = array(await read('observations', [(index + 1) % cardinality]), 4)
    if (oldest[3] === false) oldest = array(await read('observations', [0]), 4)
    const oldestTime = small(oldest[0], 32)
    int56(oldest[1])
    uint(oldest[2], 160)
    if (
      oldest[3] !== true ||
      BigInt.asUintN(32, snapshot.block.timestamp - BigInt(oldestTime)) < BigInt(p.twapWindow)
    )
      return fail()
    const observed = array(await read('observe', [[p.twapWindow, 0]]), 2)
    const ticks = array(observed[0], 2),
      liquidity = array(observed[1], 2)
    const delta = BigInt.asIntN(56, int56(ticks[1]) - int56(ticks[0]))
    const liquidityDelta = BigInt.asUintN(160, uint(liquidity[1], 160) - uint(liquidity[0], 160))
    const window = BigInt(p.twapWindow)
    let mean = delta / window
    if (delta < 0n && delta % window !== 0n) mean -= 1n
    if (mean < BigInt(MIN_TICK) || mean > BigInt(MAX_TICK) || liquidityDelta === 0n) return fail()
    const twap = Number(mean)
    const harmonicLiquidity = uint((window * ((1n << 160n) - 1n)) / (liquidityDelta << 32n), 128)
    if (
      harmonicLiquidity < p.minLiquidity ||
      currentLiquidity < p.minLiquidity ||
      Math.abs(spot - twap) > p.maxDeviationTicks
    )
      return fail()
    const allowances = await Promise.all(
      [state.protocol.token0, state.protocol.token1].map((address) =>
        reader.readContract({
          address,
          abi: TOKEN_ABI,
          functionName: 'allowance',
          args: [snapshot.binding.vault, state.protocol.router],
          blockNumber: snapshot.block.number,
        }),
      ),
    )
    const allowance0 = uint(allowances[0], 256),
      allowance1 = uint(allowances[1], 256)
    if (allowance0 !== 0n || allowance1 !== 0n) return fail()
    const canonical = (await reader.getBlock({ blockNumber: snapshot.block.number })) as Record<
      string,
      unknown
    >
    if (
      !canonical ||
      canonical.number !== snapshot.block.number ||
      typeof canonical.hash !== 'string' ||
      canonical.hash.toLowerCase() !== snapshot.block.hash.toLowerCase() ||
      canonical.timestamp !== snapshot.block.timestamp ||
      (await reader.getChainId()) !== 56
    )
      return fail()
    const market = Object.freeze({
      blockNumber: snapshot.block.number,
      blockHash: snapshot.block.hash,
      pool,
      spot,
      twap,
      sqrtPriceX96,
      currentLiquidity,
      harmonicLiquidity,
      allowance0,
      allowance1,
    })
    issued.set(market, snapshot)
    return { status: 'verified', market }
  } catch {
    return {
      status: 'blocked',
      reason:
        'Complete same-block grid oracle, pool identity and zero-allowance state could not be verified.',
    }
  }
}
