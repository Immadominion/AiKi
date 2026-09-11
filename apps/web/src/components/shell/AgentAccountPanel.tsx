'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import {
  type AgentAccount,
  accountHeadline,
  balanceView,
  explorerAccountUrl,
} from '@/lib/agent-account'
import { api } from '@/lib/api'

/**
 * The account an agent spends from, with what is actually in it.
 *
 * Before this, the address was rendered on two screens and its balance on none,
 * so "fund your agent wallet" was an instruction nobody could complete or check.
 *
 * The panel refuses to round off two facts. A balance that could not be read is
 * labelled unreadable rather than drawn as zeros, because those look identical
 * and mean opposite things to somebody who has just deposited. And the native
 * balance is shown with the reason no agent can spend it, because an account can
 * hold BNB that no mandate is able to move, and somebody funding it with BNB
 * alone would be waiting forever for something to happen.
 */
export function AgentAccountPanel() {
  const say = useToast()
  const { authenticated } = useAccount()
  const [state, setState] = useState<AgentAccount>({ kind: 'signed_out' })
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!authenticated) return setState({ kind: 'signed_out' })
    setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }))
    try {
      const account = await api.account()
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
    } catch (error) {
      setState({
        kind: 'failed',
        message:
          error instanceof Error ? error.message : 'Your account could not be read just now.',
      })
    }
  }, [authenticated])

  useEffect(() => {
    void load()
  }, [load])

  const create = async () => {
    setCreating(true)
    try {
      await api.createAccount()
      say('Account created. AiKi paid the gas; it belongs to you.')
      await load()
    } catch (error) {
      say(error instanceof Error ? error.message : 'The account could not be created.')
    } finally {
      setCreating(false)
    }
  }

  const address = state.kind === 'ready' ? state.address : null
  const view = state.kind === 'ready' ? balanceView(state.balances) : null
  const explorer = state.kind === 'ready' ? explorerAccountUrl(state.chainId, state.address) : null

  return (
    <section id="agent-account" className="mb-[26px] scroll-mt-4 last:mb-0">
      <h2 className="mb-[3px] text-[15px] font-bold">Agent account</h2>
      <p className="text-muted mt-0 mb-[12px] max-w-[660px] text-[12.5px] leading-[1.55] text-pretty">
        Separate from your own wallet. You own it, AiKi paid to create it, and an agent can only
        ever spend what is inside it, within the limits you sign.
      </p>
      <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
        <div className="flex flex-wrap items-start gap-[12px] px-4 py-[14px]">
          <span className="min-w-0 flex-1 basis-[260px]">
            <span className="block text-[13.5px] font-bold">
              {address ? 'Send tokens here' : 'Account'}
            </span>
            <span className="text-muted mt-[3px] block font-mono text-[12px] leading-[1.5] break-all">
              {address ?? accountHeadline(state)}
            </span>
            {address ? (
              <span className="text-muted mt-[6px] block text-[12.5px] leading-[1.5] text-pretty">
                {accountHeadline(state)}
              </span>
            ) : null}
          </span>
          {address ? (
            <span className="flex flex-none gap-[8px]">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(address)
                    .then(() => say('Address copied.'))
                    .catch(() => say('Your browser would not let us copy.'))
                }}
                className="text-ink-app h-[34px] rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => void load()}
                className="text-ink-app h-[34px] rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
              >
                Refresh
              </button>
            </span>
          ) : state.kind === 'none' ? (
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              className="text-ink-app h-[34px] flex-none rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] disabled:opacity-60"
            >
              {creating ? 'Creating…' : 'Create account'}
            </button>
          ) : null}
        </div>

        {view && !view.unknown ? (
          <div className="border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[14px]">
            <ul className="m-0 flex list-none flex-wrap gap-x-[28px] gap-y-[10px] p-0">
              {view.rows.map((row) => (
                <li key={row.symbol} className="min-w-[120px]">
                  <span className="block text-[15px] font-bold tabular-nums">
                    {row.amount} <span className="text-[12.5px] font-bold">{row.symbol}</span>
                  </span>
                  {row.note ? (
                    <span className="text-muted mt-[2px] block text-[11.5px] leading-[1.45]">
                      {row.note}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {explorer ? (
          <div className="border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[12px]">
            <a
              href={explorer}
              target="_blank"
              rel="noreferrer"
              className="text-[12.5px] font-bold underline"
            >
              Check it yourself on BscScan
            </a>
          </div>
        ) : null}
      </div>
    </section>
  )
}
