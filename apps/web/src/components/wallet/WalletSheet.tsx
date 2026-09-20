'use client'

import type { AccountPosture } from '@aiki/contracts'
import { money, swapVenueFor } from '@aiki/contracts'
import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { accountTokenAddress } from '@/lib/agent-account'
import {
  swapSteps,
  toBaseUnits,
  WithdrawInputError,
  withdrawTransaction,
  wrapNativeTransaction,
} from '@/lib/agent-withdraw'
import { api } from '@/lib/api'
import { sendWalletTransaction, WalletTransactionError } from '@/lib/wallet'

/**
 * One action at a time, and nothing on screen until asked for.
 *
 * The first version of this put a permanent form on the wallet page: a select,
 * two inputs and three buttons, visible whether or not anybody wanted to send
 * anything. That is a page that looks like work before you have asked it for
 * any.
 */
export function WalletSheet({
  kind,
  account,
  chainId,
  owner,
  posture,
  onClose,
  onDone,
}: {
  kind: 'send' | 'swap' | 'receive'
  account: string
  chainId: number
  owner: string
  posture: AccountPosture
  onClose: () => void
  onDone: () => void
}) {
  const say = useToast()
  const holdings = [...posture.spendable, ...posture.stranded]
  const [symbol, setSymbol] = useState(holdings[0]?.symbol ?? 'BNB')
  const [into, setInto] = useState(holdings[0]?.symbol === 'USDT' ? 'WBNB' : 'USDT')
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)

  const holding = holdings.find((h) => h.symbol === symbol)
  const stuck = Boolean(holding?.strandedBecause)

  /** A .bnb name is resolved at send time, so the address is the current one. */
  const destination = async (typed: string): Promise<string> => {
    const trimmed = typed.trim()
    if (!trimmed.toLowerCase().endsWith('.bnb')) return trimmed
    const found = await api.resolveName(trimmed).catch(() => ({ address: null }))
    if (!found.address) throw new WithdrawInputError(`${trimmed} does not point anywhere.`)
    return found.address
  }

  const run = async () => {
    if (busy || !holding) return
    setBusy(true)
    try {
      const units = kind === 'send' || kind === 'swap' ? toBaseUnits(amount, holding.decimals) : 0n
      if ((kind === 'send' || kind === 'swap') && units > BigInt(holding.raw))
        throw new WithdrawInputError(`You have ${holding.amount} ${holding.symbol}.`)

      /*
       * Native BNB is its own case and always has been. The account reverts on
       * any transfer carrying value, so an agent can never move it and a swap
       * cannot route it. Wrapping is one for one and makes it an ordinary
       * token, after which everything else on this sheet applies to it.
       */
      if (kind === 'swap' && holding.symbol === 'BNB') {
        const wbnb = accountTokenAddress(chainId, 'WBNB')
        if (!wbnb) throw new WithdrawInputError('No WBNB contract on this chain.')
        await send(wrapNativeTransaction({ owner, account, wbnb, amount: BigInt(holding.raw) }))
        say('Unstuck. It is WBNB now, and agents can spend it.')
        return onDone()
      }

      if (kind === 'swap') {
        const from = accountTokenAddress(chainId, holding.symbol) ?? holding.symbol
        const target = accountTokenAddress(chainId, into)
        if (!target) throw new WithdrawInputError(`AiKi does not know ${into}.`)
        const [quote, allowed] = await Promise.all([
          api.swapQuote(from, target, units.toString()),
          api
            .allowance(from, account)
            .then((result) => BigInt(result.allowance))
            .catch(() => 0n),
        ])
        const router = swapVenueFor(chainId)?.router
        if (!router) throw new WithdrawInputError('No reviewed exchange on this chain.')
        const steps = swapSteps({
          owner,
          account,
          chainId,
          tokenIn: from,
          tokenOut: target,
          amount: units,
          allowance: allowed,
          router,
          minOut: BigInt(quote.minOut),
          fee: quote.fee,
        })
        for (const step of steps) await send(step)
        say(steps.length > 1 ? 'Approved, then swapped.' : 'Swapped.')
        return onDone()
      }

      const token = holding.symbol === 'BNB' ? undefined : accountTokenAddress(chainId, symbol)
      await send(
        withdrawTransaction({
          owner,
          account,
          to: await destination(to),
          amount: units,
          ...(token ? { token } : {}),
        }),
      )
      say('Sent.')
      onDone()
    } catch (error) {
      if (error instanceof WithdrawInputError || error instanceof WalletTransactionError)
        say(error.message)
      else say('That did not go through. Nothing was submitted.')
    } finally {
      setBusy(false)
    }
  }

  const send = async (transaction: Parameters<typeof sendWalletTransaction>[1]) => {
    await sendWalletTransaction(owner, transaction)
  }

  return (
    <div className="fixed inset-0 z-100 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default border-0 bg-[rgb(26_26_25_/_0.35)]"
      />
      <div className="animate-rise relative w-full max-w-[420px] rounded-t-[22px] bg-white p-5 shadow-[0_24px_60px_-20px_rgb(26_26_25_/_0.4)] sm:rounded-[22px]">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-[17px] font-extrabold capitalize">{kind}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted size-8 rounded-full border-0 bg-[rgb(26_26_25_/_0.05)] text-[15px]"
          >
            ×
          </button>
        </div>

        {kind === 'receive' ? (
          <div className="mt-4">
            <p className="text-muted m-0 text-[12.5px]">Send USDT or WBNB to this address.</p>
            <p className="mt-2 mb-3 font-mono text-[12.5px] break-all">{account}</p>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(account).then(() => say('Copied.'))
              }}
              className="bg-ink-app h-11 w-full rounded-[13px] border-0 text-[13.5px] font-bold text-white"
            >
              Copy address
            </button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-[10px]">
            <div className="flex gap-[10px]">
              <select
                value={symbol}
                onChange={(event) => setSymbol(event.target.value)}
                aria-label="Asset"
                className="h-12 rounded-[13px] border border-[rgb(26_26_25_/_0.14)] bg-white px-3 text-[14px] font-bold"
              >
                {holdings.map((h) => (
                  <option key={h.symbol} value={h.symbol}>
                    {h.symbol}
                  </option>
                ))}
              </select>
              {!(kind === 'swap' && stuck) ? (
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label="Amount"
                  className="h-12 min-w-0 flex-1 rounded-[13px] border border-[rgb(26_26_25_/_0.14)] px-3 text-[16px] font-bold tabular-nums"
                />
              ) : null}
            </div>

            {holding ? (
              <div className="text-muted flex items-center gap-2 text-[12px]">
                <span>
                  {holding.amount} available · {money(holding.usd)}
                </span>
                {!(kind === 'swap' && stuck) ? (
                  <button
                    type="button"
                    onClick={() => setAmount(holding.amount)}
                    className="text-ink-app border-0 bg-none p-0 font-bold underline underline-offset-[3px]"
                  >
                    max
                  </button>
                ) : null}
              </div>
            ) : null}

            {kind === 'send' ? (
              <input
                value={to}
                onChange={(event) => setTo(event.target.value)}
                placeholder="0x… or name.bnb"
                aria-label="Send to"
                spellCheck={false}
                className="h-12 rounded-[13px] border border-[rgb(26_26_25_/_0.14)] px-3 font-mono text-[13px]"
              />
            ) : null}

            {kind === 'send' ? (
              <button
                type="button"
                onClick={() => setTo(owner)}
                className="text-ink-app h-9 self-start rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold"
              >
                To me
              </button>
            ) : null}

            {kind === 'swap' && !stuck ? (
              <label className="text-muted flex items-center gap-2 text-[12.5px]">
                into
                <select
                  value={into}
                  onChange={(event) => setInto(event.target.value)}
                  className="h-10 flex-1 rounded-[11px] border border-[rgb(26_26_25_/_0.14)] bg-white px-2 text-[13px] font-bold"
                >
                  {['USDT', 'WBNB']
                    .filter((s) => s !== symbol)
                    .map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}

            {kind === 'swap' && stuck ? (
              <p className="text-muted m-0 text-[12.5px] leading-[1.5]">
                BNB has to become WBNB first. Same value, no exchange. After that an agent can swap
                it for you.
              </p>
            ) : null}

            <button
              type="button"
              onClick={() => void run()}
              disabled={busy}
              className="bg-ink-app mt-1 h-12 w-full rounded-[13px] border-0 text-[14px] font-bold text-white disabled:cursor-wait disabled:opacity-60"
            >
              {busy
                ? 'Check your wallet'
                : kind === 'swap' && stuck
                  ? 'Unstick it'
                  : kind === 'swap'
                    ? `Swap for ${into}`
                    : 'Send'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
