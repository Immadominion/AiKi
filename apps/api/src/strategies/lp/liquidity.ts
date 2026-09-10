// SPDX-License-Identifier: GPL-2.0-or-later
// Exact BigInt port of Pancake LiquidityAmounts, commit 986847948755cba528324d41be19480731c36c2a.
// Source: projects/v3-periphery/contracts/libraries/LiquidityAmounts.sol, original Uniswap/Pancake authors.
// Matches onchain/src/strategies/pancake/PancakeMath.sol, including intermediate floors and uint128 bounds.
import { mulDiv } from '../grid/math.js'

const Q96 = 1n << 96n
export const MAX_UINT128 = (1n << 128n) - 1n
const u128 = (n: bigint) => {
  if (n < 0n || n > MAX_UINT128) throw new Error('Liquidity exceeds uint128.')
  return n
}
const order = (a: bigint, b: bigint): [bigint, bigint] => {
  if (a <= 0n || b <= 0n || a >= 1n << 160n || b >= 1n << 160n || a === b)
    throw new Error('Invalid liquidity price bounds.')
  return a < b ? [a, b] : [b, a]
}
const liquidity0 = (a: bigint, b: bigint, amount: bigint) =>
  u128(mulDiv(amount, mulDiv(a, b, Q96), b - a))
const liquidity1 = (a: bigint, b: bigint, amount: bigint) => u128(mulDiv(amount, Q96, b - a))
const amount0 = (a: bigint, b: bigint, liquidity: bigint) => mulDiv(liquidity << 96n, b - a, b) / a
const amount1 = (a: bigint, b: bigint, liquidity: bigint) => mulDiv(liquidity, b - a, Q96)

export function liquidityForAmounts(
  sqrt: bigint,
  lower: bigint,
  upper: bigint,
  a0: bigint,
  a1: bigint,
): bigint {
  const [a, b] = order(lower, upper)
  if (
    sqrt <= 0n ||
    sqrt >= 1n << 160n ||
    a0 < 0n ||
    a1 < 0n ||
    a0 >= 1n << 256n ||
    a1 >= 1n << 256n
  )
    throw new Error('Invalid liquidity inventory.')
  if (sqrt <= a) return liquidity0(a, b, a0)
  if (sqrt >= b) return liquidity1(a, b, a1)
  const l0 = liquidity0(sqrt, b, a0),
    l1 = liquidity1(a, sqrt, a1)
  return l0 < l1 ? l0 : l1
}

export function amountsForLiquidity(
  sqrt: bigint,
  lower: bigint,
  upper: bigint,
  liquidity: bigint,
): [bigint, bigint] {
  const [a, b] = order(lower, upper)
  u128(liquidity)
  if (sqrt <= 0n || sqrt >= 1n << 160n) throw new Error('Invalid liquidity price.')
  if (sqrt <= a) return [amount0(a, b, liquidity), 0n]
  if (sqrt >= b) return [0n, amount1(a, b, liquidity)]
  return [amount0(sqrt, b, liquidity), amount1(a, sqrt, liquidity)]
}
