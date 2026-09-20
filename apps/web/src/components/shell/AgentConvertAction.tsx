'use client'

import type { AccountPosture } from '@aiki/contracts'
import { money } from '@aiki/contracts'
import { useState } from 'react'
import { useAccount } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import { accountTokenAddress } from '@/lib/agent-account'
import { WithdrawInputError, wrapNativeTransaction } from '@/lib/agent-withdraw'
import { sendWalletTransaction, WalletTransactionError } from '@/lib/wallet'

/**
 * One press that turns stranded BNB into something an agent can work with.
 *
 * This is the whole answer to "let it swap the BNB", and it is not a swap. BNB
 * and WBNB are the same asset at a fixed rate of one, so wrapping cannot lose
 * value, needs no quote, no slippage bound and no exchange. What it changes is
 * only the thing that mattered: WBNB is an ERC-20 on the reviewed list, so a
 * mandate can name it, a cap can measure it, and an agent can spend or swap it
 * like any other token.
 *
 * Which means the actual swap, if one is wanted, goes back to being an agent
 * acting inside limits its owner signed, rather than a special case the app
 * performs on their behalf.
 */
export function AgentConvertAction({
  account,
  posture,
  chainId,
  onDone,
}: {
  account: string
  posture: AccountPosture
  chainId: number
  onDone?: (() => void) | undefined
}) {
  const say = useToast()
  const { address: owner, authenticated } = useAccount()
  const [busy, setBusy] = useState(false)

  const bnb = posture.stranded.find((holding) => holding.symbol === 'BNB')
  if (!authenticated || !bnb || posture.fix?.kind !== 'convert') return null

  const convert = async () => {
    if (busy) return
    setBusy(true)
    try {
      const wbnb = accountTokenAddress(chainId, 'WBNB')
      if (!wbnb) throw new WithdrawInputError('This chain has no reviewed WBNB contract.')
      const { transactionHash } = await sendWalletTransaction(
        owner,
        wrapNativeTransaction({ owner, account, wbnb, amount: BigInt(bnb.raw) }),
      )
      say(
        `Converting. ${transactionHash.slice(0, 10)}… is on chain; agents can spend it once it confirms.`,
      )
      onDone?.()
    } catch (error) {
      if (error instanceof WithdrawInputError || error instanceof WalletTransactionError)
        say(error.message)
      else say('That could not be sent. Nothing was submitted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-[11px] flex flex-wrap items-center gap-[10px]">
      <button
        type="button"
        onClick={() => void convert()}
        disabled={busy}
        className="bg-ink-app h-10 rounded-[11px] border-0 px-4 text-[12.5px] font-bold text-white disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? 'Check your wallet' : `Convert ${bnb.amount} BNB to WBNB`}
      </button>
      <span className="text-muted text-[12px] leading-[1.5]">
        One for one, no exchange and no price. {money(bnb.usd)} of BNB becomes {money(bnb.usd)} of
        WBNB, which agents can spend and swap under the limits you sign. You sign this, because the
        account refuses native value from any agent.
      </span>
    </div>
  )
}
