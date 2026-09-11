import { type AccountToken, accountTokensFor } from '@aiki/contracts'
import type { AccountBalances, ChainReader } from '../authority/chain-reader.js'

/**
 * What a mandate account holds, or an honest null.
 *
 * This exists because "fund your agent wallet" was an instruction nobody could
 * follow. The address was rendered in two places in the whole product and its
 * balance in none, so a person who sent money had no way to learn whether it
 * arrived, and Fast mode could not tell them either.
 *
 * Three rules, all of them about not lying with a number:
 *
 *   - Unknown is not zero. A failed read returns null and the caller says so.
 *     Rendering an unreadable balance as 0 tells somebody who just deposited
 *     that their money is gone.
 *   - All of it or none of it. The reader fails the whole call rather than
 *     dropping a token it could not read, because a short list looks complete.
 *   - Base units, as strings. A balance is money and never becomes a float.
 *
 * The timeout is here rather than in the transport because this sits on a route
 * Fast mode calls often. A slow RPC should cost a caller one bounded wait and a
 * null, not a hung request.
 */

export const BALANCE_READ_TIMEOUT_MS = 4_000

export async function readAccountBalances(input: {
  chain?: ChainReader
  chainId: number
  account: `0x${string}`
  timeoutMs?: number
}): Promise<AccountBalances | null> {
  const read = input.chain?.balances
  if (!read) return null

  let tokens: AccountToken[]
  try {
    tokens = accountTokensFor(input.chainId)
  } catch {
    // An execution chain with no reviewed token list. The native balance alone
    // would be misleading here, because it is the one thing no agent can spend.
    return null
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read.call(input.chain, input.account, tokens),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), input.timeoutMs ?? BALANCE_READ_TIMEOUT_MS)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
