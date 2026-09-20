'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { type AgentAccount, balanceView } from '@/lib/agent-account'
import { api } from '@/lib/api'
import { route } from '@/lib/routes'

/**
 * What the agent can actually spend, on the screen where you ask it to spend.
 *
 * The balance was on the wallet page only, so the one question Fast mode
 * exists to answer - can this be done with what I have - could not be answered
 * without leaving Fast mode. Deciding whether to swap, hire or top up while
 * looking at a number on another page is not a decision anybody makes well.
 *
 * It is one line beside the points that were already there, not a panel. A
 * balance readout that occupies the focused surface would be the same mistake
 * in the other direction: this says the amount and gets out of the way, and
 * the full account with its addresses and its unspendable native balance stays
 * one click behind it.
 */
export function FastWallet() {
  const [state, setState] = useState<AgentAccount>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    api
      .account()
      .then((account) => {
        if (!live) return
        setState(
          account.address
            ? {
                kind: 'ready',
                address: account.address,
                chainId: account.chainId,
                network: account.network,
                balances: account.balances ?? null,
              }
            : { kind: 'none' },
        )
      })
      .catch(() => {
        if (live) setState({ kind: 'failed', message: 'Wallet unreadable' })
      })
    return () => {
      live = false
    }
  }, [])

  if (state.kind === 'loading') return null

  const label = walletLabel(state)
  return (
    <Link
      href={route('/settings/wallet')}
      className="text-muted hover:text-ink-app inline-flex min-h-10 items-center gap-[5px] text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-orange-app"
    >
      <span className="text-faint">Agent wallet</span>
      <span className="text-ink-app font-bold tabular-nums">{label}</span>
    </Link>
  )
}

/**
 * The spendable total, or the reason there is not one.
 *
 * An unreadable balance is never drawn as a zero. The two look identical and
 * mean opposite things to somebody who has just deposited, and the wrong one
 * of them says the deposit failed.
 */
export function walletLabel(state: AgentAccount): string {
  if (state.kind === 'none') return 'not created'
  if (state.kind === 'failed' || state.kind === 'signed_out' || state.kind === 'loading')
    return 'unreadable'
  const view = balanceView(state.balances)
  if (view.unknown) return 'unreadable'
  const spendable = view.rows.filter((row) => row.spendable && Number(row.amount) > 0)
  if (spendable.length === 0) return 'empty'
  return spendable.map((row) => `${trim(row.amount)} ${row.symbol}`).join(' · ')
}

/** Eighteen decimals of dust is noise beside a question. */
const trim = (amount: string) => {
  const value = Number(amount)
  if (!Number.isFinite(value)) return amount
  return value >= 1 ? value.toFixed(2).replace(/\.00$/, '') : value.toPrecision(2)
}
