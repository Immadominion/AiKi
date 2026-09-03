import { InvalidAmountError } from './errors.js'

export const MAX_UINT256 = (1n << 256n) - 1n
const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/

/** Parse an API or database amount without crossing a floating-point boundary. */
export function parseBaseUnits(value: string): bigint {
  if (value.length > 78) throw new InvalidAmountError(value, 'value exceeds uint256')
  if (!CANONICAL_UNSIGNED_INTEGER.test(value)) {
    throw new InvalidAmountError(value, 'expected a canonical unsigned decimal string')
  }
  const amount = BigInt(value)
  if (amount > MAX_UINT256) throw new InvalidAmountError(value, 'value exceeds uint256')
  return amount
}

/** Serialize an in-memory amount to the only representation exposed by the API. */
export function serializeBaseUnits(value: bigint): string {
  if (value < 0n) throw new InvalidAmountError(value.toString(), 'value is negative')
  if (value > MAX_UINT256) throw new InvalidAmountError(value.toString(), 'value exceeds uint256')
  return value.toString(10)
}

export function addBaseUnits(left: bigint, right: bigint): bigint {
  serializeBaseUnits(left)
  serializeBaseUnits(right)
  return parseBaseUnits((left + right).toString())
}

export type ExactMoney = Readonly<{
  chainId: number
  token: `0x${string}`
  decimals: number
  amount: bigint
}>

export type SerializedMoney = Readonly<{
  chainId: number
  token: `0x${string}`
  decimals: number
  amount: string
}>

export function serializeMoney(money: ExactMoney): SerializedMoney {
  return { ...money, amount: serializeBaseUnits(money.amount) }
}
