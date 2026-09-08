import { BSC_MAINNET } from '../config/chains.js'

/**
 * What a job costs, and who receives what.
 *
 * Amounts are integer base units throughout, never floats: a price is money and
 * a rounding error in money is not a display bug. The fee is computed from the
 * price rather than stored alongside it, so the two cannot disagree, and it
 * rounds DOWN, meaning the platform absorbs the remainder rather than the user
 * paying a unit they were never quoted.
 */
export interface Priced {
  /** What the agent receives. */
  price: bigint
  /** What AiKi receives. */
  platformFee: bigint
  /** What leaves the user's account. Always price + platformFee. */
  total: bigint
  feeBasisPoints: number
}

/** 2.5%. One number, in one place, so a quote and an invoice cannot differ. */
export const PLATFORM_FEE_BPS = 250

export function priceJob(price: bigint, feeBasisPoints = PLATFORM_FEE_BPS): Priced {
  if (price < 0n) throw new Error('A price cannot be negative.')
  if (feeBasisPoints < 0 || feeBasisPoints > 10_000)
    throw new Error('Fee must be between 0 and 10000 basis points.')
  const platformFee = (price * BigInt(feeBasisPoints)) / 10_000n
  return { price, platformFee, total: price + platformFee, feeBasisPoints }
}

/**
 * The asset a quote settles in.
 *
 * USDT on BNB Chain has 18 decimals, not the 6 it uses elsewhere; assuming 6
 * here is a 10^12 error in every cap and every price. It also predates EIP-3009,
 * so it cannot be pulled with a signed authorization and needs an allowance
 * instead. Both facts belong on the quote, because the payment path a user is
 * about to authorize depends on them.
 */
export interface SettlementAsset {
  symbol: string
  address: string
  decimals: number
  supportsEip3009: boolean
  requiresPermit2Approval: boolean
}

export const SETTLEMENT: SettlementAsset = {
  symbol: 'U',
  address: BSC_MAINNET.contracts.settlementToken,
  decimals: 18,
  supportsEip3009: true,
  requiresPermit2Approval: false,
}

const money = (amount: bigint, asset: SettlementAsset) => ({
  amount: amount.toString(),
  asset: asset.symbol,
  decimals: asset.decimals,
  assetAddress: asset.address,
})

/**
 * A quote a user can act on.
 *
 * `total` is stated rather than left to be added up, because the number that
 * matters is the one that leaves the account, and every cap is checked against
 * that number rather than against the price.
 */
export function buildQuote(input: {
  quoteId: string
  agentId: string
  price: bigint
  asset?: SettlementAsset
  ttlSeconds?: number
  now?: () => number
}) {
  const asset = input.asset ?? SETTLEMENT
  const priced = priceJob(input.price)
  const now = input.now?.() ?? Date.now()
  return {
    quoteId: input.quoteId,
    agentId: input.agentId,
    price: money(priced.price, asset),
    platformFee: money(priced.platformFee, asset),
    total: money(priced.total, asset),
    // Gas is paid by the relayer in BNB and is not deducted from the mandate,
    // so quoting a number here would imply a charge that never happens.
    estimatedGas: null,
    settlementAsset: asset,
    feeBasisPoints: priced.feeBasisPoints,
    expiresAt: new Date(now + (input.ttlSeconds ?? 300) * 1000).toISOString(),
    protocol: 'erc8183' as const,
  }
}
