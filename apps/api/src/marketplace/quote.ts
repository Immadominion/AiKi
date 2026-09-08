import { addBaseUnits, parseBaseUnits, serializeBaseUnits } from './domain/money.js'
import { MarketplaceError } from './errors.js'

export type Quote = Readonly<{
  providerAmount: string
  platformFeeAmount: string
  totalAmount: string
}>

/** Fee rounds up so a non-zero rate cannot disappear on a small valid payment. */
export function quoteExactAmount(providerAmount: string, platformFeeBps: number): Quote {
  if (!Number.isSafeInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10_000)
    throw new MarketplaceError('INVALID_FEE', 'The platform fee is outside its allowed range.')
  const provider = parseBaseUnits(providerAmount)
  if (provider === 0n)
    throw new MarketplaceError('INVALID_PRICE', 'A fixed-price offer must pay more than zero.')
  const fee = (provider * BigInt(platformFeeBps) + 9_999n) / 10_000n
  const total = addBaseUnits(provider, fee)
  return {
    providerAmount: serializeBaseUnits(provider),
    platformFeeAmount: serializeBaseUnits(fee),
    totalAmount: serializeBaseUnits(total),
  }
}
