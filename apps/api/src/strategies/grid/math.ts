// SPDX-License-Identifier: GPL-2.0-or-later
// Exact bigint port of onchain/src/strategies/pancake/PancakeMath.sol, itself pinned to
// pancakeswap/pancake-v3-contracts 986847948755cba528324d41be19480731c36c2a.
// TickMath/OracleLibrary: original Uniswap/Pancake authors. FullMath: Remco Bloemen (MIT).
// BigInt replaces the 512-bit mulDiv implementation, preserving uint256 input/output bounds.
import type { Hex } from 'viem'

export const MIN_TICK = -887272
export const MAX_TICK = 887272
export const MIN_SQRT_RATIO = 4295128739n
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n
const MAX_UINT256 = (1n << 256n) - 1n
function uint(value: bigint, bits = 256): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(bits))
    throw new Error('Pancake integer out of range.')
  return value
}
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  uint(a)
  uint(b)
  uint(denominator)
  if (denominator === 0n) throw new Error('Pancake zero denominator.')
  return uint((a * b) / denominator)
}
export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const result = mulDiv(a, b, denominator)
  return uint(result + ((a * b) % denominator === 0n ? 0n : 1n))
}
const FACTORS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
] as const
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK)
    throw new Error('Pancake tick out of range.')
  const absolute = Math.abs(tick)
  let ratio = 1n << 128n
  for (const [i, factor] of FACTORS.entries())
    if (absolute & (1 << i)) ratio = (ratio * factor) >> 128n
  if (tick > 0) ratio = MAX_UINT256 / ratio
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}
export function quoteAtTick(tick: number, amount: bigint, base: Hex, quote: Hex): bigint {
  uint(amount, 128)
  if (
    !/^0x[0-9a-f]{40}$/i.test(base) ||
    !/^0x[0-9a-f]{40}$/i.test(quote) ||
    base.toLowerCase() === quote.toLowerCase()
  )
    throw new Error('Invalid Pancake quote pair.')
  const sqrt = sqrtRatioAtTick(tick)
  const forward = BigInt(base) < BigInt(quote)
  if (sqrt <= (1n << 128n) - 1n) {
    const ratio = sqrt * sqrt
    return forward ? mulDiv(ratio, amount, 1n << 192n) : mulDiv(1n << 192n, amount, ratio)
  }
  const ratio = mulDiv(sqrt, sqrt, 1n << 64n)
  return forward ? mulDiv(ratio, amount, 1n << 128n) : mulDiv(1n << 128n, amount, ratio)
}
