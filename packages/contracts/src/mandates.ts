import { type AccountToken, accountTokensFor, amountUnits } from './guardian.js'
import type { ConstraintKind } from './types.js'

/**
 * A mandate for moving a token, rather than for the one lending call.
 *
 * Until this existed, every mandate the product could build was `guardianConstraints`:
 * the Venus market, the repay selector, USDT. The caveat compiler has always
 * accepted arbitrary contract, selector and asset allowlists, and the enforcers
 * deployed on chain have always held them. Nothing constructed one. So an agent
 * could be given authority to repay a loan and nothing else, ever, and the
 * limitation was in the builder rather than in the chain.
 *
 * This is deliberately a small set of named shapes rather than a free-form
 * allowlist. A model choosing its own target and selector is a model choosing
 * its own authority, and the failure is not a bad answer, it is somebody's
 * money. Each shape here was written down, so what a mandate permits can be read
 * off the name.
 *
 * Note which rule is which tier. The caps, the token, the contract and the
 * selector are held by contracts. The destination is not: no enforcer reads a
 * recipient, so `recipient_allowlist` is AiKi declining to relay. That is worth
 * having and must never be drawn as though the chain were holding it.
 */

export type TokenAction = 'send' | 'approve'

/**
 * How much the agent may do on its own, inside the caps.
 *
 * The caps say how much can ever move. This says who decides each time it does,
 * and the two are not substitutes: a mandate capped at 50 USDT with no ask is
 * still 50 USDT the agent spends without a person in the loop. Somebody handing
 * an agent a funded wallet is choosing both, so both are stated.
 *
 * `never` is the honest name. It was the only behaviour this builder had before
 * this existed, and it was not visible anywhere, which is the thing being fixed.
 */
export type AskLevel = 'every' | 'over' | 'never'

/** The vocabulary the policy engine already reads. Mapped here, in one place. */
const ASK_MODE: Record<AskLevel, 'approve_every' | 'approve_above_threshold' | 'automatic'> = {
  every: 'approve_every',
  over: 'approve_above_threshold',
  never: 'automatic',
}

/** The selector each named action permits, so nothing infers one from a string. */
const SELECTOR: Record<TokenAction, `0x${string}`> = {
  send: '0xa9059cbb', // transfer(address,uint256)
  approve: '0x095ea7b3', // approve(address,uint256)
}

const VERB: Record<TokenAction, string> = {
  send: 'send it',
  approve: 'let a contract take it',
}

/** Matches Constants.MAX_ALLOWLIST in Types.sol. Above this the enforcer reverts. */
const MAX_ALLOWLIST = 32

export interface ActionMandateInput {
  chainId: number
  /** Which token. Must be one this chain's reviewed list names. */
  symbol: string
  /**
   * Where value may land. Required and non-empty on purpose: a token mandate
   * with no destination rule permits sending the full cap anywhere, which is
   * the entire risk this builder exists to bound.
   */
  recipients: string[]
  can: TokenAction[]
  perAction: number
  total: number
  expiresInDays: number
  /**
   * Whether a person is asked before each action. Required, with no default:
   * the one answer nobody should arrive at by omission is the one that lets an
   * agent spend without asking.
   */
  ask: AskLevel
  /** Whole tokens. Required by `over`, meaningless to the other two. */
  askOver?: number
}

/**
 * The shape `POST /v1/authorizations` accepts, which is not the richer
 * `MandateConstraint` the v1 contract renders. Named apart so the two cannot be
 * passed for one another.
 */
export interface AuthorizationConstraint {
  kind: ConstraintKind
  value: unknown
  tier: 'T0' | 'T2'
  label: string
}

const address = (value: string): string => {
  /*
   * Case-insensitive including the prefix. EIP-55 puts meaning in the case of
   * the hex digits and none in the `0x`, and a caller that sends `0X` has made
   * no mistake worth refusing over. The comparison downstream is lowercase, so
   * normalising here is what makes the allowlist match at all.
   */
  const normalised = typeof value === 'string' ? value.toLowerCase() : ''
  if (!/^0x[0-9a-f]{40}$/.test(normalised) || /^0x0+$/.test(normalised))
    throw new Error(`${String(value)} is not an address a mandate can name.`)
  return normalised
}

export function tokenFor(chainId: number, symbol: string): AccountToken {
  const token = accountTokensFor(chainId).find(
    (candidate) => candidate.symbol.toLowerCase() === symbol.toLowerCase(),
  )
  if (!token)
    throw new Error(
      `This network has no reviewed token called ${symbol}. Choose one of: ${accountTokensFor(
        chainId,
      )
        .map((candidate) => candidate.symbol)
        .join(', ')}.`,
    )
  return token
}

export function actionMandateConstraints(input: ActionMandateInput): AuthorizationConstraint[] {
  const token = tokenFor(input.chainId, input.symbol)

  const actions = [...new Set(input.can)]
  if (actions.length === 0) throw new Error('Say what the agent may do with the token.')
  // `in` walks the prototype chain, so 'toString' and 'constructor' passed
  // this guard and compiled a function into a selector allowlist.
  for (const action of actions)
    if (!Object.hasOwn(SELECTOR, action))
      throw new Error(`${action} is not something a mandate can permit.`)

  const recipients = [...new Set(input.recipients.map(address))]
  if (recipients.length === 0)
    throw new Error(
      'Name at least one address the agent may send to. A mandate with none is unbounded.',
    )
  if (recipients.length > MAX_ALLOWLIST)
    throw new Error(`A mandate can name at most ${MAX_ALLOWLIST} addresses.`)

  const perAction = amountUnits(input.perAction, token.decimals, token.symbol)
  const total = amountUnits(input.total, token.decimals, token.symbol)
  if (BigInt(perAction) > BigInt(total))
    throw new Error('The per-action cap cannot exceed the total cap.')

  if (
    !Number.isSafeInteger(input.expiresInDays) ||
    input.expiresInDays < 1 ||
    input.expiresInDays > 365
  )
    throw new Error('Choose an expiry between 1 and 365 whole days.')

  if (!Object.hasOwn(ASK_MODE, input.ask))
    throw new Error('Say whether the agent asks before every action, over an amount, or never.')
  let threshold = '0'
  if (input.ask === 'over') {
    if (typeof input.askOver !== 'number' || !Number.isFinite(input.askOver) || input.askOver <= 0)
      throw new Error('Say the amount the agent should start asking over, in whole tokens.')
    threshold = amountUnits(input.askOver, token.decimals, token.symbol)
    /*
     * A threshold at or above the per-action cap never fires.
     *
     * The gate asks when the amount is strictly over the threshold, and the cap
     * already refuses anything over itself, so `over 50` on a mandate capped at
     * 50 is `never` wearing the word "over". Someone who chose to be asked would
     * be told they had been, and never would be. Refused rather than silently
     * accepted, because the failure is invisible until the money has moved.
     */
    if (BigInt(threshold) >= BigInt(perAction))
      throw new Error(
        `Asking only over ${input.askOver} ${token.symbol} would never ask, because this mandate already refuses anything over ${input.perAction} ${token.symbol} in one action. Choose a lower amount, or ask every time.`,
      )
  }

  const permitted = actions.map((action) => VERB[action]).join(' and ')

  return [
    {
      kind: 'expiry',
      value: new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
      tier: 'T0',
      label: `expires in ${input.expiresInDays} days`,
    },
    {
      kind: 'contract_allowlist',
      // The token contract is the only thing called: both `transfer` and
      // `approve` are calls on the token itself, not on whoever receives.
      value: [token.address],
      tier: 'T0',
      label: `only the ${token.symbol} contract`,
    },
    {
      kind: 'selector_allowlist',
      value: actions.map((action) => SELECTOR[action]),
      tier: 'T0',
      label: `only ${permitted}`,
    },
    { kind: 'asset_scope', value: [token.address], tier: 'T0', label: `only ${token.symbol}` },
    {
      kind: 'per_action_cap',
      value: perAction,
      tier: 'T0',
      label: `${input.perAction} ${token.symbol} per action`,
    },
    {
      kind: 'session_total_cap',
      value: total,
      tier: 'T0',
      label: `${input.total} ${token.symbol} in total`,
    },
    {
      kind: 'recipient_allowlist',
      value: recipients,
      tier: 'T2',
      label:
        recipients.length === 1
          ? `only to ${recipients[0]}`
          : `only to ${recipients.length} named addresses`,
    },
    {
      kind: 'approval',
      value: { mode: ASK_MODE[input.ask], threshold },
      /*
       * T2 and it could not be anything else. No contract can wait for a
       * person: the chain takes a transaction or it does not, so "hold this
       * until somebody answers" is AiKi declining to relay. This is the control
       * somebody reaches for when they trust the agent least, which makes
       * drawing it as chain-held the worst available lie.
       */
      tier: 'T2',
      label:
        input.ask === 'every'
          ? 'asks you before every action'
          : input.ask === 'over'
            ? `asks you over ${input.askOver} ${token.symbol}`
            : 'acts without asking, inside these limits',
    },
  ]
}
