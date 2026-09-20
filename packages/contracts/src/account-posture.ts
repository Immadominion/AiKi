/**
 * What an account can actually do, rather than whether a number is zero.
 *
 * The balance readout had two states, funded and empty, and called an account
 * holding $1.07 of BNB "empty". That is wrong twice over: the money is there,
 * and the reason it cannot be used is not that it is missing. Somebody told
 * "empty" goes and finds more money. Somebody told "you hold $1.07, no mandate
 * can move BNB, here is how to convert it" does the thing that works.
 *
 * Native value is the case worth naming. `executeFromExecutor` on the account
 * reverts with `NativeValueNotSupported()` for any non-zero value, so no agent
 * acting under any mandate can move BNB, wrap it, or spend it on gas. It is not
 * a limit of the mandate somebody wrote; it is the account. Only the owner can
 * move it, through `execute`, `withdrawNative` or `withdrawERC20`.
 *
 * So "stranded" is its own state: real money, in the wrong form, with a way
 * out that belongs to the owner and not to the agent.
 */

export interface PostureHolding {
  symbol: string
  /** Base units, as a string. A balance is money and never becomes a float. */
  raw: string
  decimals: number
  /** Formatted for display. */
  amount: string
  /** Dollars, when a price was available for it. Never invented. */
  usd: number | null
  /** Why no agent can spend this, when that is the case. */
  strandedBecause?: string
}

export type PostureState = 'no_account' | 'unreadable' | 'empty' | 'stranded' | 'dust' | 'ready'

export type PostureFix =
  | { kind: 'create' }
  | { kind: 'fund'; symbols: string[] }
  /** Owner-signed. The agent cannot do this one and saying otherwise is a lie. */
  | { kind: 'convert'; from: 'BNB'; to: 'WBNB'; ownerSigned: true }
  | { kind: 'top_up'; symbols: string[] }

export interface AccountPosture {
  state: PostureState
  /** What an agent can spend under a mandate. */
  spendable: PostureHolding[]
  /** What the account holds that no mandate can move. */
  stranded: PostureHolding[]
  spendableUsd: number | null
  strandedUsd: number | null
  /** One line, safe to put in a chip. */
  headline: string
  /** The sentence that says what to do about it. */
  detail: string
  fix: PostureFix | null
}

/**
 * Below this, a spendable balance is present but cannot buy anything useful.
 *
 * Named rather than inlined because it is a judgement, not a fact: it is the
 * point under which a swap's gas and slippage eat the trade, so calling the
 * balance "ready" would set somebody up to watch a transaction fail.
 */
export const DUST_USD = 0.5

const NATIVE_STRANDED =
  'No mandate can move native BNB, so no agent can spend it. Only you can, from your own wallet.'

export function formatAmount(raw: string, decimals: number): string {
  const negative = raw.startsWith('-')
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Dollars for a base-unit balance, or null when nothing priced it. */
export function usdOf(raw: string, decimals: number, priceUsd: number | null): number | null {
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd < 0) return null
  const amount = Number(formatAmount(raw, decimals))
  if (!Number.isFinite(amount)) return null
  return amount * priceUsd
}

export const money = (usd: number | null): string =>
  usd === null ? 'unpriced' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`

const sum = (holdings: PostureHolding[]): number | null => {
  const priced = holdings.filter((h) => h.usd !== null)
  // Some of it priced is not the total. A partial sum presented as the total
  // understates what somebody holds, which is the direction that loses money.
  if (priced.length !== holdings.length) return null
  return priced.reduce((total, h) => total + (h.usd ?? 0), 0)
}

export interface PostureInput {
  /** Null when the account does not exist yet. */
  address: string | null
  /** Null when the chain could not be read. Never coerce this to zeros. */
  balances: {
    native: string
    tokens: { symbol: string; raw: string; decimals: number }[]
  } | null
  prices?: { bnbUsd?: number | null; usdtUsd?: number | null } | undefined
}

export function accountPosture(input: PostureInput): AccountPosture {
  const base = { spendable: [], stranded: [], spendableUsd: null, strandedUsd: null, fix: null }

  if (!input.address)
    return {
      ...base,
      state: 'no_account',
      headline: 'not created',
      detail: 'AiKi pays the gas to create one. It belongs to you.',
      fix: { kind: 'create' },
    }

  if (!input.balances)
    return {
      ...base,
      state: 'unreadable',
      headline: 'unreadable',
      detail:
        'The chain could not be read just now. This does not mean the account is empty, so nothing here is drawn as a zero.',
    }

  const bnbUsd = input.prices?.bnbUsd ?? null
  const usdtUsd = input.prices?.usdtUsd ?? null
  const priceFor = (symbol: string) =>
    symbol === 'WBNB' || symbol === 'BNB' ? bnbUsd : symbol === 'USDT' ? (usdtUsd ?? 1) : null

  const stranded: PostureHolding[] = []
  if (input.balances.native !== '0')
    stranded.push({
      symbol: 'BNB',
      raw: input.balances.native,
      decimals: 18,
      amount: formatAmount(input.balances.native, 18),
      usd: usdOf(input.balances.native, 18, bnbUsd),
      strandedBecause: NATIVE_STRANDED,
    })

  const spendable: PostureHolding[] = input.balances.tokens
    .filter((token) => token.raw !== '0')
    .map((token) => ({
      symbol: token.symbol,
      raw: token.raw,
      decimals: token.decimals,
      amount: formatAmount(token.raw, token.decimals),
      usd: usdOf(token.raw, token.decimals, priceFor(token.symbol)),
    }))

  const spendableUsd = sum(spendable)
  const strandedUsd = sum(stranded)
  const symbols = input.balances.tokens.map((token) => token.symbol)
  const listed = spendable.map((h) => `${h.amount} ${h.symbol}`).join(' · ')

  if (spendable.length === 0 && stranded.length === 0)
    return {
      ...base,
      state: 'empty',
      headline: 'empty',
      detail: `Nothing in it yet. Send ${symbols.join(' or ')} to the account address and an agent can start spending inside the limits you sign.`,
      fix: { kind: 'fund', symbols },
    }

  // Money in the wrong shape. Loudest state, because it is the one that looks
  // like poverty and is not.
  if (spendable.length === 0)
    return {
      ...base,
      stranded,
      strandedUsd,
      state: 'stranded',
      headline: `${money(strandedUsd)} stuck in BNB`,
      /*
       * WBNB rather than USDT, because that is what the button does and the
       * two must not disagree. Wrapping is one for one and carries no price;
       * turning it into USDT afterwards is a swap, with a rate and a limit,
       * and that is a mandate to write rather than a step to bury in a
       * sentence about unsticking your own money.
       */
      detail: `${stranded[0]?.amount} BNB is in the account, worth ${money(strandedUsd)}. ${NATIVE_STRANDED} Convert it to WBNB, which agents can spend and swap, or send ${symbols.join(' or ')} instead.`,
      fix: { kind: 'convert', from: 'BNB', to: 'WBNB', ownerSigned: true },
    }

  if (spendableUsd !== null && spendableUsd < DUST_USD)
    return {
      ...base,
      spendable,
      stranded,
      spendableUsd,
      strandedUsd,
      state: 'dust',
      headline: `${listed} · too small`,
      detail: `${money(spendableUsd)} is spendable, which will not survive the gas and slippage on a trade. Top it up before putting an agent on it.`,
      fix: { kind: 'top_up', symbols },
    }

  return {
    state: 'ready',
    spendable,
    stranded,
    spendableUsd,
    strandedUsd,
    headline: listed,
    detail:
      stranded.length > 0
        ? `${listed} can be spent by an agent inside the limits you sign. The ${stranded[0]?.amount} BNB alongside it cannot: ${NATIVE_STRANDED}`
        : `${listed} can be spent by an agent inside the limits you sign.`,
    fix: null,
  }
}
