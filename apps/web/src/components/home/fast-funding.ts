import type { FundingContinuation } from '@/lib/api'

/**
 * Where to send money, as something you press rather than something you read.
 *
 * A person asked an agent to trade one dollar for them and was told, correctly,
 * that native BNB cannot be spent and that an address needed funding. The
 * address was in the reply. It was the fortieth word of the first paragraph,
 * and they did not find it, and they went to a different screen and made a
 * second wallet instead.
 *
 * So it renders where funding is the question and nowhere else. No balance on
 * it: a running readout on the surface somebody works on is chrome, and this
 * has one job.
 */
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** History contains data, not authority. Revalidate before offering a control. */
export function parseFundingContinuation(value: unknown): FundingContinuation | null {
  const action = object(value)
  const symbols = Array.isArray(action?.symbols)
    ? action.symbols.filter((entry): entry is string => typeof entry === 'string').slice(0, 4)
    : []
  if (
    action?.kind !== 'fund_account' ||
    typeof action.address !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(action.address) ||
    /^0x0{40}$/i.test(action.address) ||
    (action.chainId !== 56 && action.chainId !== 97) ||
    symbols.length === 0
  )
    return null
  return {
    kind: 'fund_account',
    address: action.address.toLowerCase(),
    chainId: action.chainId,
    symbols,
  }
}

/** Only the tool that reads the account may put this on screen. */
export function fundingContinuations(steps: unknown): FundingContinuation[] {
  const actions = new Map<string, FundingContinuation>()
  for (const value of Array.isArray(steps) ? steps : []) {
    const step = object(value)
    const action =
      step?.ok === true && step.tool === 'my_account' ? parseFundingContinuation(step.action) : null
    if (action) actions.set(action.address, action)
  }
  return [...actions.values()]
}

/** One sentence naming what may be sent. Two tokens is a list, not a paragraph. */
export function acceptedTokens(symbols: string[]): string {
  if (symbols.length === 1) return symbols[0] ?? ''
  return `${symbols.slice(0, -1).join(', ')} or ${symbols.at(-1)}`
}

/*
 * There was a "Swap BNB for USDT" button here that opened PancakeSwap.
 *
 * It is gone because it could not do the thing its position on the card
 * implied. It opens an exchange connected to the reader's OWN wallet, and the
 * BNB the card is talking about is in the agent account, which that exchange
 * cannot see, touch or spend. Somebody holding a dollar of stranded BNB and
 * pressing it arrived at a swap screen for a different balance entirely.
 *
 * The account's own BNB moves one of two ways, both owner-signed, because
 * `executeFromExecutor` reverts on any non-zero value and so no agent under
 * any mandate can move it: convert it in place through the account's `execute`,
 * or take it out with `withdrawNative`. Both are transactions from this app,
 * against the account on the card, and neither is a link somewhere else.
 */
