/**
 * Reading the destination out of a call, so a mandate can bound where money goes
 * and not only how much.
 *
 * The caps already answer "how much", and the chain answers it independently by
 * decoding the same calldata in `AmountLib`. Nothing answers "to whom". A
 * mandate permitting `transfer` on a token, capped at some amount, lets whoever
 * holds it send that amount to any address in the world. That was contained
 * while the only delegate was AiKi's own executor and the only shipped mandate
 * was a Venus repayment, which names no recipient at all. It stops being
 * contained the moment a model composes the calldata.
 *
 * No enforcer holds this on chain, so a recipient rule is AiKi refusing to
 * relay rather than the chain refusing to execute, and it must be rendered as
 * exactly that. It is still worth having: it is the difference between an
 * injected prompt costing a capped amount and costing nothing.
 *
 * The decode is deliberately a small fixed table rather than a general ABI
 * decoder. A rule applied to calldata whose shape is guessed is not a rule, so
 * an unknown selector resolves to nothing and the caller fails closed.
 */

/** Where the destination sits, per selector, as a zero-based word after the selector. */
const RECIPIENT_ARG_INDEX: Record<string, number> = {
  '0xa9059cbb': 0, // transfer(address to, uint256)
  '0x23b872dd': 1, // transferFrom(address from, address to, uint256)
  /*
   * approve(address spender, uint256). The spender is the destination that
   * matters: an allowance is a promise to let somebody take the tokens later,
   * so a rule that bounded only `transfer` would leave the obvious way around
   * it open.
   */
  '0x095ea7b3': 0,
}

const WORD = 64
const ADDRESS_TAIL = 40

/**
 * The address a call sends value to, or null when this call shape does not name
 * one and null when it should but the calldata is too short to hold it.
 *
 * Both cases are null on purpose. The caller cannot tell "this call has no
 * recipient" from "this call is malformed" and must not be allowed to treat
 * either as permission.
 */
export function recipientOf(selector: string, callData: string): `0x${string}` | null {
  const index = RECIPIENT_ARG_INDEX[selector.toLowerCase()]
  if (index === undefined) return null

  // Lowercase the STRING, not just the prefix test. Slicing the original left
  // checksum-cased calldata with uppercase hex, which the address check below
  // then rejected, refusing a payment the mandate explicitly permits.
  const lower = callData.toLowerCase()
  const body = lower.startsWith('0x') ? lower.slice(2) : lower
  // The selector occupies the first four bytes of the calldata itself.
  const args = body.slice(8)
  const start = index * WORD
  const word = args.slice(start, start + WORD)
  if (word.length !== WORD) return null

  // An ABI address is right-aligned in its word. Anything in the leading twelve
  // bytes means this is not an address, and guessing past it would bound the
  // wrong value.
  const padding = word.slice(0, WORD - ADDRESS_TAIL)
  if (!/^0+$/.test(padding)) return null

  const address = word.slice(WORD - ADDRESS_TAIL)
  if (!/^[0-9a-f]{40}$/.test(address)) return null
  return `0x${address}`
}

/**
 * The selector the calldata actually carries, or null when it is too short to
 * hold one.
 *
 * A caller states a selector alongside the calldata, and the two are allowed to
 * disagree unless something compares them. The policy engine checks the stated
 * one against the allowlist while the chain executes the other, so the comparison
 * has to happen before either.
 */
export function selectorOf(callData: string): `0x${string}` | null {
  const lower = callData.toLowerCase()
  const body = lower.startsWith('0x') ? lower.slice(2) : lower
  if (body.length < 8) return null
  const selector = body.slice(0, 8)
  return /^[0-9a-f]{8}$/.test(selector) ? `0x${selector}` : null
}

/** Whether a call shape names a destination at all. Used to explain a refusal. */
export const namesRecipient = (selector: string) =>
  RECIPIENT_ARG_INDEX[selector.toLowerCase()] !== undefined
