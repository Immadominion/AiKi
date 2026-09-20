'use client'

import type { AccountPosture, PostureHolding } from '@aiki/contracts'
import { money } from '@aiki/contracts'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import { explorerAccountUrl } from '@/lib/agent-account'
import { api, type CreditBalance } from '@/lib/api'
import { route } from '@/lib/routes'
import { WalletSheet } from './WalletSheet'

/**
 * The money screen. One of them.
 *
 * Before this there were three: an agent account panel inside a settings tab,
 * a points page somewhere else, and a "Points" row in the sidebar pointing
 * somewhere different from the "Points" tab beside it. The person who built
 * this app could not say what lived where, which is the whole argument.
 *
 * The balance is the headline because it is the question. The three things you
 * can do with it sit under it because they are the answer. Everything else is
 * a row: what it is, what it is worth, and whether it works. Nothing explains
 * itself until you touch it.
 */
export function WalletView() {
  const say = useToast()
  const { authenticated, address: owner } = useAccount()
  const [posture, setPosture] = useState<AccountPosture | null>(null)
  const [account, setAccount] = useState<{ address: string; chainId: number } | null>(null)
  const [credits, setCredits] = useState<CreditBalance | null>(null)
  const [sheet, setSheet] = useState<'send' | 'swap' | 'receive' | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!authenticated) return
    const [read, balance] = await Promise.all([
      api.account().catch(() => null),
      api.credits().catch(() => null),
    ])
    setPosture(read?.posture ?? null)
    setAccount(read?.address ? { address: read.address, chainId: read.chainId } : null)
    setCredits(balance)
  }, [authenticated])

  useEffect(() => {
    void load()
  }, [load])

  const create = async () => {
    setBusy(true)
    try {
      await api.createAccount()
      await load()
      say('Created. AiKi paid the gas; it is yours.')
    } catch {
      say('That could not be created just now.')
    } finally {
      setBusy(false)
    }
  }

  const holdings = posture ? [...posture.spendable, ...posture.stranded] : []
  const total =
    posture === null
      ? null
      : posture.spendableUsd === null || posture.strandedUsd === null
        ? (posture.spendableUsd ?? posture.strandedUsd)
        : posture.spendableUsd + posture.strandedUsd

  return (
    <PageCard title="Wallet" count="" tabs={[]} tabHint="">
      <div className="mx-auto max-w-[620px] pb-6">
        <div className="pt-2 pb-5 text-center">
          {/* A big dash over the word "wallet" reads as a balance of nothing.
              Signed out there is no balance to be wrong about, so there is no
              number. */}
          {authenticated ? (
            <div className="text-[40px] leading-[1.1] font-extrabold tracking-[-0.03em] tabular-nums">
              {posture === null ? '·' : total === null ? 'unpriced' : money(total)}
            </div>
          ) : null}
          <div className="text-muted mt-1 text-[13px]">Agent wallet</div>
          {account ? (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(account.address)
                  .then(() => say('Copied.'))
                  .catch(() => say('Your browser would not let us copy.'))
              }}
              className="text-muted hover:text-ink-app mt-2 border-0 bg-none font-mono text-[12px]"
            >
              {account.address.slice(0, 6)}…{account.address.slice(-4)} ⧉
            </button>
          ) : null}
        </div>

        {account ? (
          <div className="flex justify-center gap-[10px]">
            {(['send', 'swap', 'receive'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setSheet(kind)}
                className="bg-ink-app hover:bg-orange-app h-11 min-w-[104px] rounded-[14px] border-0 px-5 text-[13.5px] font-bold text-white capitalize transition-colors"
              >
                {kind}
              </button>
            ))}
          </div>
        ) : authenticated ? (
          <div className="text-center">
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="bg-ink-app h-11 rounded-[14px] border-0 px-5 text-[13.5px] font-bold text-white disabled:opacity-60"
            >
              {busy ? 'Creating…' : 'Create wallet'}
            </button>
            <p className="text-muted mt-2 mb-0 text-[12.5px]">AiKi pays the gas. It is yours.</p>
          </div>
        ) : (
          <p className="text-muted m-0 text-center text-[13px]">Sign in to see your wallet.</p>
        )}

        {holdings.length > 0 ? (
          <ul className="m-0 mt-6 list-none p-0">
            {holdings.map((holding) => (
              <Row key={holding.symbol} holding={holding} onFix={() => setSheet('swap')} />
            ))}
          </ul>
        ) : null}

        {posture?.state === 'unreadable' ? (
          <p className="text-muted mt-6 mb-0 text-center text-[12.5px]">
            Balances could not be read. They are not zero.
          </p>
        ) : null}

        {credits ? (
          <div className="mt-6 flex items-center gap-3 rounded-[16px] bg-[rgb(26_26_25_/_0.04)] px-4 py-[14px]">
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold tabular-nums">
                {credits.balance.toLocaleString()} points
              </span>
              <span className="text-muted text-[12px]">What AiKi charges for its own work</span>
            </span>
            <Link
              href={route('/credits')}
              className="text-ink-app h-9 flex-none rounded-[11px] bg-white px-3 text-[12.5px] leading-9 font-bold"
            >
              Add
            </Link>
          </div>
        ) : null}

        {account ? (
          <p className="mt-5 mb-0 text-center text-[12px]">
            <a
              href={explorerAccountUrl(account.chainId, account.address) ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="text-muted underline underline-offset-4"
            >
              View on BscScan
            </a>
          </p>
        ) : null}
      </div>

      {sheet && account && posture ? (
        <WalletSheet
          kind={sheet}
          account={account.address}
          chainId={account.chainId}
          owner={owner}
          posture={posture}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null)
            void load()
          }}
        />
      ) : null}
    </PageCard>
  )
}

/**
 * One holding.
 *
 * The warning is the only prose on the row, and only when something is wrong,
 * because a row that explains itself every time is a row nobody reads.
 */
function Row({ holding, onFix }: { holding: PostureHolding; onFix: () => void }) {
  const stuck = Boolean(holding.strandedBecause)
  return (
    <li className="flex items-center gap-3 border-b border-[rgb(26_26_25_/_0.06)] py-[13px] last:border-b-0">
      <span
        aria-hidden
        className="size-[9px] flex-none rounded-full"
        style={{ background: stuck ? '#C2410C' : '#16A34A' }}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-bold">{holding.symbol}</span>
        {stuck ? (
          <button
            type="button"
            onClick={onFix}
            className="border-0 bg-none p-0 text-[12px] font-semibold underline underline-offset-[3px]"
            style={{ color: '#C2410C' }}
          >
            agents cannot spend this — fix it
          </button>
        ) : null}
      </span>
      <span className="flex-none text-right">
        <span className="block text-[14px] font-bold tabular-nums">{holding.amount}</span>
        <span className="text-muted block text-[12px] tabular-nums">{money(holding.usd)}</span>
      </span>
    </li>
  )
}
