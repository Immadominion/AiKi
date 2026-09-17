import { type AskLevel, approvalConstraint } from './approval.js'
import { type AccountToken, accountTokensFor, amountUnits, swapVenueFor } from './guardian.js'
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

export type TokenAction = 'send' | 'approve' | 'swap'

/** The selector each named action permits, so nothing infers one from a string. */
const SELECTOR: Record<TokenAction, `0x${string}`> = {
  send: '0xa9059cbb', // transfer(address,uint256)
  approve: '0x095ea7b3', // approve(address,uint256)
  /*
   * exactInputSingle on the reviewed router. A swap is the one action here
   * whose target is not the token: the account approves the router on the
   * token, then calls the router. Both halves are in the mandate or neither
   * works, which is why `swap` expands into two selectors and two targets
   * rather than one of each.
   */
  swap: '0x04e45aaf',
}

const VERB: Record<TokenAction, string> = {
  send: 'send it',
  approve: 'let a contract take it',
  swap: 'swap it',
}

/** Matches Constants.MAX_ALLOWLIST in Types.sol. Above this the enforcer reverts. */
const MAX_ALLOWLIST = 32

export interface ActionMandateInput {
  chainId: number
  /** Which token, by symbol, when it is one this chain's reviewed list names. */
  symbol: string
  /**
   * A token resolved from the chain instead, for anything the list does not
   * name.
   *
   * The reviewed list is two tokens. An account receives whatever anybody sends
   * it, so somebody holding a token they actually want to use could not write a
   * mandate for it at all: their own money was unreachable through their own
   * account. When this is supplied it IS the token, and `symbol` is ignored.
   *
   * Resolved by reading the contract, never by trusting a name typed into a
   * chat. Whoever supplies it is stating that they read it off chain.
   */
  token?: AccountToken
  /**
   * Where value may land. Required and non-empty on purpose: a token mandate
   * with no destination rule permits sending the full cap anywhere, which is
   * the entire risk this builder exists to bound.
   */
  recipients: string[]
  /**
   * The spending account, required when `can` includes `swap`.
   *
   * A swap's proceeds have to land somewhere, and the only safe somewhere is
   * the account the mandate spends from. Passed in rather than derived because
   * this package does not know whose account it is.
   */
  account?: string
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

/**
 * A token that came from outside this package, checked before it becomes a cap.
 *
 * The caps are an amount of this token and the allowlists are its address, so a
 * malformed one does not produce a weaker mandate, it produces a nonsensical
 * one. Decimals bound at 36 because every real ERC-20 is far below it and the
 * amount maths is exponential in this number.
 */
function checkedToken(token: AccountToken): AccountToken {
  const resolved = address(token.address)
  const symbol = String(token.symbol ?? '')
    .trim()
    .slice(0, 16)
  if (!symbol) throw new Error('That token does not say what it is called.')
  if (!Number.isSafeInteger(token.decimals) || token.decimals < 0 || token.decimals > 36)
    throw new Error('That token does not report usable decimals.')
  return { address: resolved as `0x${string}`, symbol, decimals: token.decimals }
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
  const token = input.token ? checkedToken(input.token) : tokenFor(input.chainId, input.symbol)

  const actions = [...new Set(input.can)]
  if (actions.length === 0) throw new Error('Say what the agent may do with the token.')
  // `in` walks the prototype chain, so 'toString' and 'constructor' passed
  // this guard and compiled a function into a selector allowlist.
  for (const action of actions)
    if (!Object.hasOwn(SELECTOR, action))
      throw new Error(`${action} is not something a mandate can permit.`)

  /*
   * A swap needs the router in the contract allowlist, and the account itself
   * as the only permitted recipient.
   *
   * Both halves matter. Without the router in `contract_allowlist` the call is
   * refused by the chain. Without the account pinned as the recipient, an agent
   * allowed to swap could send the proceeds anywhere, and no cap would notice:
   * the caps measure the token going OUT, and the token coming back is an asset
   * they say nothing about.
   */
  const swapping = actions.includes('swap')
  const venue = swapping ? swapVenueFor(input.chainId) : null
  if (swapping && !venue) throw new Error('This network has no reviewed venue to swap through.')
  if (swapping && !input.account)
    throw new Error('A swap mandate needs the account the bought tokens return to.')

  /*
   * Both legs, or neither works. A router moves the token with transferFrom, so
   * the account has to approve it first: a mandate permitting only the swap
   * selector describes a call that always reverts. So `swap` carries `approve`
   * with it, and the router joins the destinations because an approval's
   * destination IS its spender.
   */
  const recipients = [
    ...new Set([
      ...input.recipients.map(address),
      ...(venue && input.account ? [address(input.account), address(venue.router)] : []),
    ]),
  ]
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
      // `transfer` and `approve` are calls on the token itself. A swap is the
      // exception: it is a call on the router, so the router joins the list and
      // nothing else ever does.
      value: venue ? [token.address, venue.router] : [token.address],
      tier: 'T0',
      label: venue
        ? `only the ${token.symbol} contract and ${venue.label}`
        : `only the ${token.symbol} contract`,
    },
    {
      kind: 'selector_allowlist',
      value: [
        ...new Set([
          ...actions.map((action) => SELECTOR[action]),
          ...(swapping ? [SELECTOR.approve] : []),
        ]),
      ],
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
    approvalConstraint({
      ask: input.ask,
      ...(input.askOver === undefined ? {} : { askOver: input.askOver }),
      perActionUnits: perAction,
      symbol: token.symbol,
      decimals: token.decimals,
      units: amountUnits,
    }),
  ]
}
