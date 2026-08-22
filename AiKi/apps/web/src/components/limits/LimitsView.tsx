'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { TIER_MEANS, TIER_WORD, weakest } from '@/components/hire/mandate'
import { EmptyState, NoWallet } from '@/components/shell/EmptyState'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { SpendMeter } from '@/components/ui/SpendMeter'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'
import { agentHref, route } from '@/lib/routes'

/** What each hired agent is currently allowed to do, and what it has used. */
const HIRED: {
  key: AgentKey
  spent: string
  cap: string
  pct: string
  hot?: boolean
  expires: string
}[] = [
  { key: 'guardian', spent: '$14.20', cap: '$250', pct: '5.7%', expires: '30 September 2026' },
  {
    key: 'gridly',
    spent: '$31.80',
    cap: '$120',
    pct: '26.5%',
    hot: true,
    expires: '12 October 2026',
  },
  { key: 'sentinel', spent: '$0.00', cap: '$40', pct: '0%', expires: '3 November 2026' },
]

export function LimitsView() {
  const say = useToast()
  const router = useRouter()
  const { connected, ready } = useAccount()
  const [confirming, setConfirming] = useState<AgentKey | null>(null)
  const [paused, setPaused] = useState<Partial<Record<AgentKey, boolean>>>({})

  const hired = connected ? HIRED : []
  const allTiers = hired.flatMap((h) => DETAILS[h.key].enforcement.map((e) => e.tier))
  const overall = weakest(allTiers)
  const softCount = hired.flatMap((h) =>
    DETAILS[h.key].enforcement.filter((e) => e.tier !== 'T0' || !e.verified),
  ).length

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <div className="min-w-0 flex-1 basis-[240px]">
        <span className="block text-[19px] font-extrabold tracking-[-0.02em]">Limits</span>
        <p className="text-muted mt-[3px] mb-0 max-w-[640px] text-[13px] leading-[1.45] text-pretty">
          Every rule you have handed out, and who actually holds it. Nothing on this page is a
          setting the agent can read — these are refusals.
        </p>
      </div>
      <button
        type="button"
        disabled={!hired.length}
        onClick={() => {
          const all = Object.fromEntries(hired.map((h) => [h.key, true]))
          setPaused(all)
          say(
            `All ${hired.length} paused. Nothing was sent, nothing was spent, and nothing costs gas.`,
          )
        }}
        className="text-ink-app h-[38px] w-full flex-none rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-4 text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] disabled:opacity-40 sm:w-auto"
      >
        Pause everything
      </button>
    </div>
  )

  if (!ready) return <PageSkeleton rows={4} />

  return (
    <PageCard
      title="Limits"
      count=""
      headerSlot={header}
      tabs={[]}
      tabHint=""
      banner={
        softCount > 0
          ? {
              title: `${softCount} of your limits are not held by the chain.`,
              body: 'They still hold against a buggy agent. They do not hold against a compromised AiKi, and it would be dishonest to draw them the same way.',
              cta: 'How we test',
              onAction: () => router.push(route('/how-we-test')),
            }
          : undefined
      }
    >
      <div className="max-w-[900px]">
        {!hired.length ? (
          !connected ? (
            <NoWallet what="every limit you have handed out" />
          ) : (
            <EmptyState
              title="You have not granted anything."
              body="Limits only exist once you hire an agent. Until then there is no authority to hold, on chain or anywhere else."
              action="Find an agent"
              href="/explore"
            />
          )
        ) : (
          <>
            <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[16px]">
              <div className="text-muted text-[12.5px] font-semibold">
                Weakest link across everything you have authorised
              </div>
              <div className="mt-[6px] flex items-baseline gap-[9px]">
                <span
                  className="text-[26px] font-extrabold tracking-[-0.02em]"
                  style={{
                    color: overall === 'T0' ? 'var(--color-ink-app)' : 'var(--color-warn-ink)',
                  }}
                >
                  {TIER_WORD[overall]}
                </span>
                <span className="text-faint text-[12px] font-semibold">holds it</span>
              </div>
              <p className="text-muted mt-[8px] mb-0 max-w-[620px] text-[12.5px] leading-[1.5] text-pretty">
                {TIER_MEANS[overall]}
              </p>
            </div>

            {hired.map((h) => {
              const d = DETAILS[h.key]
              const row = AGENT_BY_KEY[h.key]
              return (
                <div
                  key={h.key}
                  className="mt-[14px] rounded-[18px] border border-[rgb(26_26_25_/_0.08)]"
                >
                  <div className="flex flex-wrap items-center gap-[12px] border-b border-[rgb(26_26_25_/_0.06)] px-4 py-[14px]">
                    <span
                      className="flex size-9 flex-none items-center justify-center rounded-xl text-[14px] font-extrabold text-white"
                      style={{ background: AGENT_BG[h.key] }}
                    >
                      {row.initial}
                    </span>
                    <span className="min-w-0 flex-1 basis-[160px]">
                      <span className="block text-[14px] font-bold">{row.name}</span>
                      <span className="text-muted mt-px block text-[12px]">
                        {paused[h.key] ? 'Paused by you · ' : 'Stops on its own · '}
                        {h.expires}
                      </span>
                    </span>
                    <span className="w-full min-w-[160px] sm:w-[200px]">
                      <SpendMeter value={h.spent} cap={h.cap} pct={h.pct} hot={h.hot} />
                    </span>
                    <span className="flex w-full flex-none gap-[6px] sm:w-auto">
                      <button
                        type="button"
                        onClick={() => router.push(agentHref(h.key))}
                        className="text-ink-app h-[34px] flex-1 rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] sm:flex-none"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(h.key)}
                        className="text-ink-app h-[34px] flex-1 rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] sm:flex-none"
                      >
                        Revoke
                      </button>
                    </span>
                  </div>

                  {d.enforcement.map((e) => {
                    const soft = e.tier !== 'T0' || !e.verified
                    return (
                      <div
                        key={e.label}
                        className="flex flex-wrap items-start gap-[11px] border-b border-[rgb(26_26_25_/_0.05)] px-4 py-[12px] last:border-b-0"
                      >
                        <span className="min-w-0 flex-1 basis-[220px] text-[13px] leading-[1.45] font-semibold text-pretty">
                          {e.label}
                        </span>
                        <span
                          className="flex-none rounded-full px-[9px] py-[3px] text-[11px] font-bold"
                          style={
                            soft
                              ? {
                                  background: 'var(--color-warn-bg)',
                                  color: 'var(--color-warn-ink)',
                                }
                              : { background: 'rgb(26 26 25 / 0.05)', color: 'var(--color-muted)' }
                          }
                        >
                          {TIER_WORD[e.tier]}
                        </span>
                        {e.caveat ? (
                          <span className="w-full text-[12px] leading-[1.5] text-pretty text-[#6B5A34]">
                            {e.caveat}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )
            })}

            <p className="text-muted mt-[16px] mb-0 max-w-[680px] text-[12.5px] leading-[1.5] text-pretty">
              Pausing is instant and costs nothing, because it only stops AiKi relaying. Revoking
              sends a transaction that removes the authority from the chain — slower, costs gas, and
              the only one of the two that survives AiKi disappearing.
            </p>
          </>
        )}
      </div>

      {confirming ? (
        <ConfirmDialog
          title={`Revoke ${AGENT_BY_KEY[confirming].name}?`}
          body={`This sends a transaction that removes the authority from the chain. It costs gas, it cannot be undone, and ${AGENT_BY_KEY[confirming].name} stops for good.`}
          alternative="If you only want it to stop for now, pause instead — instant, free, and reversible."
          alternativeLabel="Pause instead"
          confirmLabel="Revoke on chain"
          onCancel={() => setConfirming(null)}
          onAlternative={() => {
            const name = AGENT_BY_KEY[confirming].name
            setConfirming(null)
            setPaused((p) => ({ ...p, [confirming]: true }))
            say(`${name} paused. Nothing was sent, nothing was spent.`)
          }}
          onConfirm={() => {
            const name = AGENT_BY_KEY[confirming].name
            setConfirming(null)
            say(`Sign the transaction to revoke ${name}.`)
          }}
        />
      ) : null}
    </PageCard>
  )
}
