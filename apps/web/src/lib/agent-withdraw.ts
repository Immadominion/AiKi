import type { ReviewedWalletTransaction } from './wallet'

/**
 * Taking your money back out of the agent account.
 *
 * The account has carried `withdrawERC20` and `withdrawNative` since it was
 * deployed, both `onlyOwner`, and nothing in the product reached either one.
 * So the answer to "can I just tell it to send this to me" was yes on chain
 * and no everywhere a person could look, which is the same as no.
 *
 * These are owner transactions, not agent actions, and the distinction is the
 * whole safety story rather than a technicality. An agent moves money only
 * inside a mandate you signed, to destinations that mandate names. Draining
 * the account to an address typed in a box is not something any mandate should
 * ever permit, so it is not something an agent can be asked to do: it is you,
 * from your own wallet, with your own key.
 *
 * Native BNB has no other exit. `executeFromExecutor` reverts with
 * `NativeValueNotSupported()` for any non-zero value, so no mandate can move
 * it, no agent can wrap it, and this is the only way it leaves.
 */

const SELECTOR = {
  /** withdrawERC20(address,address,uint256) */
  withdrawERC20: '0x44004cc1',
  /** withdrawNative(address,uint256) */
  withdrawNative: '0x07b18bde',
} as const

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export class WithdrawInputError extends Error {}

const word = (value: bigint): string => {
  if (value < 0n || value >= 1n << 256n)
    throw new WithdrawInputError('That amount is out of range.')
  return value.toString(16).padStart(64, '0')
}

const addressWord = (value: string, what: string): string => {
  if (!ADDRESS.test(value)) throw new WithdrawInputError(`${what} is not a wallet address.`)
  if (/^0x0{40}$/i.test(value))
    throw new WithdrawInputError(
      `${what} is the zero address. Anything sent there is destroyed and cannot be recovered.`,
    )
  return value.slice(2).toLowerCase().padStart(64, '0')
}

export interface WithdrawRequest {
  owner: string
  /** The mandate account holding the money. */
  account: string
  /** Where it should end up. The owner's own wallet, or anyone else's. */
  to: string
  /** Base units. Money never becomes a float on the way to a transaction. */
  amount: bigint
  /** Omit for native BNB. */
  token?: string | undefined
}

/**
 * The exact transaction, built here so the wallet shows what was intended.
 *
 * Every field is checked before it becomes calldata rather than after, because
 * a malformed destination that reaches a wallet is a signature request for a
 * transfer into nowhere, and the wallet cannot tell it apart from a good one.
 */
export function withdrawTransaction(request: WithdrawRequest): ReviewedWalletTransaction {
  if (!ADDRESS.test(request.owner)) throw new WithdrawInputError('Connect a wallet first.')
  if (!ADDRESS.test(request.account))
    throw new WithdrawInputError('This account has not been created yet.')
  if (request.amount <= 0n) throw new WithdrawInputError('Enter an amount above zero.')

  const to = addressWord(request.to, 'The destination')
  const data = request.token
    ? `${SELECTOR.withdrawERC20}${addressWord(request.token, 'The token')}${to}${word(request.amount)}`
    : `${SELECTOR.withdrawNative}${to}${word(request.amount)}`

  return {
    chainId: 56,
    from: request.owner,
    to: request.account,
    data: data as `0x${string}`,
    // The account sends from its own balance. This transaction carries none.
    value: '0',
  }
}

/**
 * A typed amount into base units, without floating point touching it.
 *
 * `Number` would round a balance, and a rounded withdrawal either leaves dust
 * behind or asks for more than is there and reverts. The string is taken apart
 * by hand instead.
 */
export function toBaseUnits(input: string, decimals: number): bigint {
  const trimmed = input.trim()
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.')
    throw new WithdrawInputError('Enter an amount, like 0.5.')
  const [whole = '', fraction = ''] = trimmed.split('.')
  if (fraction.length > decimals)
    throw new WithdrawInputError(`This token has ${decimals} decimal places, no more.`)
  return BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0')}`)
}

/**
 * Turning the account's stranded BNB into something an agent can spend.
 *
 * Asked for as "please let this thing be able to swap it". The answer is
 * better than a swap and it is one transaction.
 *
 * WBNB is an ordinary ERC-20 and it is on the reviewed token list, so a
 * mandate can name it, a cap can measure it, and an agent can spend or swap it
 * like any other token. Wrapping is `deposit()` on the WBNB contract with the
 * BNB attached, and the BNB comes from the ACCOUNT's own balance rather than
 * from the owner's, because `execute(target, value, callData)` forwards the
 * value out of the account it lives on. So the owner's transaction carries no
 * value at all, and the exchange rate is exactly one.
 *
 * What this avoids is worth saying. Routing the same BNB through a swap would
 * need a quote, a slippage bound, an approval and a router, and would put a
 * price on a conversion that does not have one. Wrapping is 1:1 and cannot
 * come back with less than went in. Once it is WBNB, whether to swap it, for
 * what, and at what limit, is a mandate the owner writes and an agent carries
 * out, which is where that decision belonged in the first place.
 *
 * The owner signs because `executeFromExecutor` reverts on any non-zero value,
 * so no agent under any mandate can perform this step for them. Simulated
 * against a live account before it shipped: accepted from the owner, reverted
 * with NotOwner for everybody else.
 */
const EXECUTE = '0xb61d27f6'
/** deposit() on WBNB. */
const DEPOSIT = 'd0e30db0'

export function wrapNativeTransaction(request: {
  owner: string
  account: string
  wbnb: string
  amount: bigint
}): ReviewedWalletTransaction {
  if (!ADDRESS.test(request.owner)) throw new WithdrawInputError('Connect a wallet first.')
  if (!ADDRESS.test(request.account))
    throw new WithdrawInputError('This account has not been created yet.')
  if (request.amount <= 0n)
    throw new WithdrawInputError('There is no BNB in the account to convert.')

  // execute(address,uint256,bytes): the bytes argument is dynamic, so it is a
  // head offset followed by its length and its body, padded to a word.
  const data =
    EXECUTE +
    addressWord(request.wbnb, 'The WBNB contract') +
    word(request.amount) +
    word(96n) +
    word(4n) +
    DEPOSIT.padEnd(64, '0')

  return {
    chainId: 56,
    from: request.owner,
    to: request.account,
    data: data as `0x${string}`,
    // The account sends its own BNB. This transaction carries none of the
    // owner's, which is what makes it safe to sign from a wallet holding more.
    value: '0',
  }
}
