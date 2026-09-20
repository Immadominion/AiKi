import { type AskLevel, approvalConstraint } from './approval.js'
/** Canonical Venus repayment inputs. Registry and billing chains do not select these. */
export interface GuardianConfig {
  chainId: 56 | 97
  network: 'mainnet' | 'testnet'
  asset: `0x${string}`
  market: `0x${string}`
  decimals: 6 | 18
  repayBorrowSelector: '0x0e752702'
}

export function guardianFor(chainId: number): GuardianConfig {
  if (chainId === 56)
    return {
      chainId,
      network: 'mainnet',
      asset: '0x55d398326f99059ff775485246999027b3197955',
      market: '0xfd5840cd36d94d7229439859c0112a4185bc0255',
      decimals: 18,
      repayBorrowSelector: '0x0e752702',
    }
  if (chainId === 97)
    return {
      chainId,
      network: 'testnet',
      asset: '0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c',
      market: '0xb7526572ffe56ab9d7489838bf2e18e3323b441a',
      decimals: 6,
      repayBorrowSelector: '0x0e752702',
    }
  throw new Error('This execution network is not supported for Venus repayment.')
}

export interface ExecutionNetwork {
  configured: true
  chainId: 56 | 97
  network: 'mainnet' | 'testnet'
  audited: boolean
  manager: `0x${string}`
  guardian: GuardianConfig
}

/** Fail closed on old APIs, malformed metadata or a noncanonical asset. */
export function parseExecutionNetwork(value: unknown): ExecutionNetwork {
  const invalid = () =>
    new Error('AiKi execution network details could not be verified. No action was started.')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  if (
    input.configured !== true ||
    (input.chainId !== 56 && input.chainId !== 97) ||
    typeof input.audited !== 'boolean' ||
    typeof input.manager !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.manager) ||
    /^0x0{40}$/.test(input.manager)
  )
    throw invalid()
  const guardian = guardianFor(input.chainId)
  const reported = input.guardian as Record<string, unknown> | null | undefined
  if (
    input.network !== guardian.network ||
    !reported ||
    Array.isArray(reported) ||
    reported.chainId !== guardian.chainId ||
    reported.network !== guardian.network ||
    typeof reported.asset !== 'string' ||
    reported.asset.toLowerCase() !== guardian.asset ||
    typeof reported.market !== 'string' ||
    reported.market.toLowerCase() !== guardian.market ||
    reported.decimals !== guardian.decimals ||
    reported.repayBorrowSelector !== guardian.repayBorrowSelector
  )
    throw invalid()
  return {
    configured: true,
    chainId: guardian.chainId,
    network: guardian.network,
    audited: input.audited,
    manager: input.manager.toLowerCase() as `0x${string}`,
    guardian,
  }
}

/** Exact expansion of a JSON number, including scientific notation, never float multiplication. */
export function amountUnits(value: number, decimals: number, symbol = 'USDT'): string {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    throw new Error(`Enter a positive ${symbol} cap within the supported number range.`)
  const [coefficient = '', exponent = '0'] = value.toString().toLowerCase().split('e')
  const [whole = '', fraction = ''] = coefficient.split('.')
  const digits = BigInt(`${whole}${fraction}`)
  const scale = decimals + Number(exponent) - fraction.length
  if (scale < 0) {
    const divisor = 10n ** BigInt(-scale)
    if (digits % divisor !== 0n)
      throw new Error(`${symbol} caps on this network support at most ${decimals} decimal places.`)
    return (digits / divisor).toString()
  }
  return (digits * 10n ** BigInt(scale)).toString()
}

export function guardianConstraints(input: {
  chainId: number
  perActionUsdt: number
  totalUsdt: number
  expiresInDays: number
  /**
   * Whether a person is asked before each repayment.
   *
   * Optional, and absent means no rule at all rather than a permissive one, so
   * a mandate built without it is byte-for-byte the six it has always been.
   * Callers that only use this to validate numbers, and every mandate signed
   * before gates existed, keep working unchanged. The tools a person actually
   * reaches this through require an answer.
   */
  ask?: AskLevel
  askOver?: number
}) {
  const guardian = guardianFor(input.chainId)
  const perAction = amountUnits(input.perActionUsdt, guardian.decimals)
  const total = amountUnits(input.totalUsdt, guardian.decimals)
  if (BigInt(perAction) > BigInt(total))
    throw new Error('The per-action cap cannot exceed the total cap.')
  if (
    !Number.isSafeInteger(input.expiresInDays) ||
    input.expiresInDays < 1 ||
    input.expiresInDays > 365
  )
    throw new Error('Choose an expiry between 1 and 365 whole days.')
  return [
    {
      kind: 'expiry',
      value: new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
      tier: 'T0',
      label: `expires in ${input.expiresInDays} days`,
    },
    {
      kind: 'contract_allowlist',
      value: [guardian.market],
      tier: 'T0',
      label: 'only the Venus USDT market',
    },
    {
      kind: 'selector_allowlist',
      value: [guardian.repayBorrowSelector],
      tier: 'T0',
      label: 'only repaying a loan',
    },
    { kind: 'asset_scope', value: [guardian.asset], tier: 'T0', label: 'only USDT' },
    {
      kind: 'per_action_cap',
      value: perAction,
      tier: 'T0',
      label: `${input.perActionUsdt} USDT per action`,
    },
    {
      kind: 'session_total_cap',
      value: total,
      tier: 'T0',
      label: `${input.totalUsdt} USDT in total`,
    },
    /*
     * The watch is the one thing in this product that moves money while nobody
     * is looking, which makes it the mandate that most needs a gate and the one
     * that had none. Worth saying what choosing it costs: a guardian that has
     * to ask cannot repay while the answer is outstanding, so a loan can be
     * liquidated waiting for one. That is a real trade and it belongs to the
     * person, not to this builder.
     */
    ...(input.ask === undefined
      ? []
      : [
          approvalConstraint({
            ask: input.ask,
            ...(input.askOver === undefined ? {} : { askOver: input.askOver }),
            perActionUnits: perAction,
            symbol: 'USDT',
            decimals: guardian.decimals,
            units: amountUnits,
          }),
        ]),
  ]
}

/**
 * A token worth naming when reporting what a mandate account holds.
 *
 * Deliberately a short, per-chain, reviewed list rather than a discovery sweep.
 * An account's balance is shown to a person deciding whether to fund it, and a
 * list assembled from transfer logs would show every token anybody had ever
 * pushed into it, including the ones sent to make a scam look plausible. What
 * is not on this list is not hidden, it is simply not something AiKi names.
 */
export interface AccountToken {
  address: `0x${string}`
  symbol: string
  decimals: number
}

/**
 * What to report for a mandate account on a given execution chain.
 *
 * USDT first because it is what every shipped mandate is denominated in. WBNB
 * is named on mainnet for one blunt reason: native BNB can never move under a
 * delegation, because the manager and the account both refuse a nonzero value,
 * so wrapped is the only form of BNB an agent can ever act on. Showing it beside
 * the native balance is how somebody learns that without reading Solidity.
 */
/**
 * The one venue a mandate may swap through, per chain.
 *
 * Reviewed rather than discovered. A router is an address a signed mandate lets
 * an agent hand tokens to, so it is the last place to accept whatever a model
 * found in a search result. This is PancakeSwap's V3 SmartRouter, checked on
 * chain: its WETH9 is the same WBNB this file already names, its factory is the
 * PancakeSwap V3 factory, and its bytecode carries the selector below.
 *
 * `0x04e45aaf` is exactInputSingle in its SwapRouter02 shape, which encodes the
 * amount at a fixed word. The older deadline-carrying router is a different
 * selector and a different layout, and is deliberately not supported rather
 * than assumed equivalent.
 */
export interface SwapVenue {
  router: `0x${string}`
  selector: `0x${string}`
  label: string
}

const SWAP_VENUES: Record<number, SwapVenue> = {
  56: {
    router: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
    selector: '0x04e45aaf',
    label: 'PancakeSwap v3',
  },
  97: {
    router: '0x1b81d678ffb9c0263b24a97847620c99d213eb14',
    selector: '0x04e45aaf',
    label: 'PancakeSwap v3',
  },
}

export function swapVenueFor(chainId: number): SwapVenue | null {
  return SWAP_VENUES[chainId] ?? null
}

export function accountTokensFor(chainId: number): AccountToken[] {
  const guardian = guardianFor(chainId)
  const usdt: AccountToken = {
    address: guardian.asset,
    symbol: 'USDT',
    decimals: guardian.decimals,
  }
  if (chainId !== 56) return [usdt]
  return [
    usdt,
    {
      address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      symbol: 'WBNB',
      decimals: 18,
    },
  ]
}

/**
 * The price feeds AiKi reads, and only these.
 *
 * Chainlink aggregators on the execution chain rather than a price API,
 * because a balance is shown next to a decision about money and the number
 * beside it should come from the same place the balance does. No key, no
 * vendor, and the staleness of the answer is on chain where it can be checked.
 *
 * `staleAfterSeconds` is each feed's own heartbeat with headroom. A price older
 * than that is reported as unpriced rather than as a number, because a stale
 * quote and a current one look identical once rendered.
 */
export interface PriceFeed {
  symbol: 'BNB' | 'USDT'
  address: `0x${string}`
  staleAfterSeconds: number
}

export function priceFeedsFor(chainId: number): PriceFeed[] {
  if (chainId !== 56) return []
  return [
    {
      symbol: 'BNB',
      address: '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee',
      staleAfterSeconds: 3 * 60 * 60,
    },
    {
      symbol: 'USDT',
      address: '0xb97ad0e74fa7d920791e90258a6e2085088b4320',
      staleAfterSeconds: 3 * 60 * 60,
    },
  ]
}
