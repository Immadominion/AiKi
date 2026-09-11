import type { AccountBalances } from './api'
import { formatUnits, isZeroAmount } from './format'

/**
 * What the agent account panel says, decided away from React.
 *
 * The panel exists because "fund your agent wallet" was not a followable
 * instruction: the address appeared in two screens and its balance in none, so
 * a person who sent money had no way to find out whether it arrived.
 *
 * Two distinctions carry the whole thing, and both are easy to flatten by
 * accident:
 *
 *   - Unknown is not empty. A chain we could not read must not render as a row
 *     of zeros to somebody who just deposited.
 *   - Native is not spendable. The account can hold BNB and an agent can never
 *     move it, because the manager and the account both refuse a nonzero value.
 *     Showing the balance without that sentence invites somebody to fund the
 *     account with the one asset no mandate can touch.
 */

export interface BalanceRow {
  symbol: string
  /** Already formatted for display. Base units never reach the screen. */
  amount: string
  /** Why this row is not what an agent spends, when that is true. */
  note?: string
  spendable: boolean
}

export interface BalanceView {
  rows: BalanceRow[]
  /** The chain could not be read. Say so; do not show zeros. */
  unknown: boolean
  /** Nothing an agent could act on is in there yet. */
  needsFunding: boolean
  summary: string
}

const NATIVE_NOTE = 'Held, but no agent can move it. Only the owner can.'

export function balanceView(balances: AccountBalances | null | undefined): BalanceView {
  if (!balances)
    return {
      rows: [],
      unknown: true,
      needsFunding: false,
      summary: 'Balances could not be read just now. This does not mean the account is empty.',
    }

  const rows: BalanceRow[] = [
    {
      symbol: 'BNB',
      amount: formatUnits(balances.native, 18),
      note: NATIVE_NOTE,
      spendable: false,
    },
    ...balances.tokens.map((token) => ({
      symbol: token.symbol,
      amount: formatUnits(token.raw, token.decimals),
      spendable: true,
    })),
  ]

  const spendable = balances.tokens.filter((token) => !isZeroAmount(token.raw))
  if (spendable.length === 0) {
    /*
     * Not "empty". Only the reviewed tokens are read, so an account holding
     * something else entirely would be told its money is not there, which is the
     * same error as rendering an unreadable balance as zero. Say what was
     * actually checked and point at the explorer for the rest.
     */
    const named = balances.tokens.map((token) => token.symbol).join(' or ')
    return {
      rows,
      unknown: false,
      needsFunding: true,
      summary: isZeroAmount(balances.native)
        ? `No ${named} here. Send some to the address below. Other tokens may be in this account, but no agent can spend them.`
        : `Holds BNB, which no agent can spend, and no ${named}. Send some to the address below.`,
    }
  }

  return {
    rows,
    unknown: false,
    needsFunding: false,
    summary: `Ready to spend: ${spendable
      .map((token) => `${formatUnits(token.raw, token.decimals)} ${token.symbol}`)
      .join(', ')}.`,
  }
}

export type AgentAccount =
  | { kind: 'signed_out' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | {
      kind: 'ready'
      address: string
      chainId: number
      network: string | null
      balances: AccountBalances | null
    }
  | { kind: 'failed'; message: string }

/**
 * One sentence for the current state.
 *
 * `none` is deliberately not phrased as an error. Not having an account yet is
 * the ordinary state of a new person, and the panel offers to make one.
 */
export function accountHeadline(state: AgentAccount): string {
  switch (state.kind) {
    case 'signed_out':
      return 'Sign in to see the account your agents spend from.'
    case 'loading':
      return 'Reading your account.'
    case 'none':
      return 'No account yet. AiKi pays the gas to create one; it belongs to you.'
    case 'failed':
      return state.message
    case 'ready':
      return balanceView(state.balances).summary
  }
}

/** The explorer a person checks the account on, per execution chain. */
export function explorerAccountUrl(chainId: number, address: string): string | null {
  if (chainId === 56) return `https://bscscan.com/address/${address}`
  if (chainId === 97) return `https://testnet.bscscan.com/address/${address}`
  return null
}

/**
 * One line for a header: what the agent can actually spend.
 *
 * Deliberately not a full balance list. The question this answers is "does the
 * agent have anything to work with", and the three answers are none, some, and
 * we could not tell. The third is never rendered as the first.
 */
export function agentWalletLine(balances: AccountBalances | null | undefined): string {
  if (balances === undefined) return 'Agent wallet'
  if (!balances) return 'Agent wallet: balance unreadable'
  const spendable = balances.tokens.filter((token) => !isZeroAmount(token.raw))
  if (spendable.length === 0) return 'Agent wallet: nothing to spend'
  return spendable
    .map((token) => `${formatUnits(token.raw, token.decimals)} ${token.symbol}`)
    .join(', ')
}
