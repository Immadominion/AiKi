'use client'

import type { AccountPosture, PostureHolding } from '@aiki/contracts'
import { money } from '@aiki/contracts'
import { useState } from 'react'
import { useAccount } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import { accountTokenAddress } from '@/lib/agent-account'
import { toBaseUnits, WithdrawInputError, withdrawTransaction } from '@/lib/agent-withdraw'
import { api } from '@/lib/api'
import { sendWalletTransaction, WalletTransactionError } from '@/lib/wallet'

/**
 * Sending the account's money back to yourself, or to anybody else.
 *
 * Asked for in these words: "can I just tell the agent to send it to me? I hope
 * that's possible?" It was possible and unreachable. `withdrawERC20` and
 * `withdrawNative` have been on the deployed account the whole time, both
 * owner-only, and no route, tool or button touched either.
 *
 * It is deliberately not something the agent does. A mandate names the
 * destinations an agent may send to; an arbitrary address typed into a box is
 * the one thing a mandate must never permit, or the limits mean nothing. So
 * this is your wallet, your key, your transaction, against your account.
 *
 * Native BNB has no other way out at all.
 */
export function AgentWithdrawPanel({
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
  const holdings = [...posture.spendable, ...posture.stranded]
  const [symbol, setSymbol] = useState(holdings[0]?.symbol ?? 'BNB')
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)

  const holding = holdings.find((h) => h.symbol === symbol)
  if (!authenticated || holdings.length === 0) return null

  /**
   * A typed destination, resolved if it is a name.
   *
   * Nobody reads a hex address before pressing send, so a .bnb name is the
   * safer thing to type as well as the easier one. It is resolved here rather
   * than as you type, so the address that goes into the transaction is the one
   * the name pointed at a second ago and not one cached from earlier.
   */
  const destination = async (typed: string): Promise<string> => {
    const trimmed = typed.trim()
    if (!trimmed.toLowerCase().endsWith('.bnb')) return trimmed
    const resolved = await api.resolveName(trimmed).catch(() => ({ address: null }))
    if (!resolved.address)
      throw new WithdrawInputError(
        `${trimmed} does not point at an address. Check the name, or paste the address instead.`,
      )
    say(`${trimmed} resolves to ${resolved.address}.`)
    return resolved.address
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !holding) return
    setBusy(true)
    try {
      const token =
        holding.symbol === 'BNB' ? undefined : accountTokenAddress(chainId, holding.symbol)
      if (holding.symbol !== 'BNB' && !token)
        throw new WithdrawInputError(`AiKi does not know the address of ${holding.symbol}.`)
      const request = {
        owner,
        account,
        to: await destination(to),
        amount: toBaseUnits(amount, holding.decimals),
        ...(token ? { token } : {}),
      }
      // Never offer to send more than is there: the account would revert and
      // the gas would be spent proving it.
      if (request.amount > BigInt(holding.raw))
        throw new WithdrawInputError(`The account holds ${holding.amount} ${holding.symbol}.`)
      const { transactionHash } = await sendWalletTransaction(owner, withdrawTransaction(request))
      say(
        `Sent. ${transactionHash.slice(0, 10)}… is on chain; the balance updates when it confirms.`,
      )
      setAmount('')
      setTo('')
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
    <form onSubmit={submit} className="px-4 py-[14px]">
      <div className="text-[13.5px] font-bold">Send it somewhere</div>
      <p className="text-muted mt-[3px] mb-[11px] text-[12.5px] leading-[1.5] text-pretty">
        Your wallet signs this, not an agent. An agent can only send where a mandate you signed says
        it may, which is why moving money to an address you choose is yours to do.
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
          aria-label="What to send"
          className="h-10 rounded-[11px] border border-[rgb(26_26_25_/_0.16)] bg-white px-2 text-[12.5px] font-semibold"
        >
          {holdings.map((h) => (
            <option key={h.symbol} value={h.symbol}>
              {h.symbol}
            </option>
          ))}
        </select>
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder="Amount"
          aria-label="Amount"
          className="h-10 w-[112px] rounded-[11px] border border-[rgb(26_26_25_/_0.16)] px-3 text-[12.5px]"
        />
        <input
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="0x… or a .bnb name"
          aria-label="Destination address"
          spellCheck={false}
          className="h-10 min-w-[220px] flex-1 rounded-[11px] border border-[rgb(26_26_25_/_0.16)] px-3 font-mono text-[12px]"
        />
        <button
          type="button"
          onClick={() => setTo(owner)}
          className="text-ink-app h-10 rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
        >
          To me
        </button>
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="bg-ink-app h-10 rounded-[11px] border-0 px-4 text-[12.5px] font-bold text-white disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? 'Check your wallet' : 'Send'}
        </button>
      </div>
      {holding ? <Available holding={holding} onAll={() => setAmount(holding.amount)} /> : null}
    </form>
  )
}

function Available({ holding, onAll }: { holding: PostureHolding; onAll: () => void }) {
  return (
    <p className="text-muted mt-2 mb-0 text-[12px]">
      {holding.amount} {holding.symbol} available
      {holding.usd === null ? '' : ` · ${money(holding.usd)}`}{' '}
      <button
        type="button"
        onClick={onAll}
        className="text-ink-app border-0 bg-none font-semibold underline underline-offset-[3px]"
      >
        send all
      </button>
      {holding.strandedBecause ? (
        <span className="block mt-1">{holding.strandedBecause}</span>
      ) : null}
    </p>
  )
}
