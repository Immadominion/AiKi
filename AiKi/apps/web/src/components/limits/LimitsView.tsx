'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { TIER_MEANS, TIER_WORD, weakest } from '@/components/hire/mandate'
import { EmptyState, NoWallet } from '@/components/shell/EmptyState'
import { PageCard } from '@/components/shell/PageCard'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { SpendMeter } from '@/components/ui/SpendMeter'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'
import { hiredRows } from '@/lib/present'
import { agentHref, route } from '@/lib/routes'
import { useMock } from '@/mock/store'
import { usd } from '@/mock/types'

const PERIOD_WORD = {
  per_transaction: 'in one action',
  per_month: 'a month',
  per_year: 'a year',
  total: 'in total, ever',
} as const

export function LimitsView() {
  const say = useToast()
  const router = useRouter()
  const { state, ready, pause, revoke } = useMock()
  const [confirming, setConfirming] = useState<AgentKey | null>(null)

  const rows = hiredRows(state.hires, state.jobs)
  const allTiers = state.hires.flatMap((h) => DETAILS[h.key].enforcement.map((e) => e.tier))
  const overall = weakest(allTiers)
  const softCount = state.hires.flatMap((h) =>
    DETAILS[h.key].enforcement.filter((e) => e.tier !== 'T0' || !e.verified),
  ).length

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <div className="min-w-0 flex-1 basis-[240px]">
        <span className="block text-[19px] font-extrabold tracking-[-0.02em]">Limits</span>
        <p className="text-muted mt-[3px] mb-0 max-w-[640px] text-[13px] leading-[1.45] text-pretty">
          Every rule you have handed out, and who actually holds it. Nothing on this page is a
          setting the agent can read. These are refusals.
        </p>
      </div>
      <button
        type="button"
        disabled={!rows.length}
        onClick={() => {
          for (const h of state.hires) pause(h.key)
          say(
            `All ${rows.length} paused. Nothing was sent, nothing was spent, and nothing costs gas.`,
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
              onAction: () => router.push(route('/docs/how-we-test')),
            }
          : undefined
      }
    >
      <div className="max-w-[900px]">
        {!rows.length ? (
          !state.connected ? (
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

            {state.hires.map((h) => {
              const d = DETAILS[h.key]
              const agent = AGENT_BY_KEY[h.key]
              const row = rows.find((r) => r.key === h.key)
              if (!row) return null

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
                      {agent.initial}
                    </span>
                    <span className="min-w-0 flex-1 basis-[160px]">
                      <span className="block text-[14px] font-bold">{agent.name}</span>
                      <span className="text-muted mt-px block text-[12px]">
                        {h.status === 'paused' ? 'Paused by you · stops ' : 'Stops on its own · '}
                        {row.expires}
                      </span>
                    </span>
                    <span className="w-full min-w-[160px] sm:w-[200px]">
                      <SpendMeter value={row.spent} cap={row.cap} pct={row.pct} hot={row.hot} />
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

                  {/* The caps you actually chose, not the ones the passport
                      advertises — those are two different claims. */}
                  <div className="flex flex-wrap items-start gap-[11px] border-b border-[rgb(26_26_25_/_0.05)] px-4 py-[12px]">
                    <span className="min-w-0 flex-1 basis-[220px] text-[13px] leading-[1.45] font-semibold text-pretty">
                      Never more than {usd(h.mandate.perActionCents)} in one action, or{' '}
                      {usd(h.mandate.capCents)} {PERIOD_WORD[h.mandate.period]}
                    </span>
                    <span className="text-muted flex-none rounded-full bg-[rgb(26_26_25_/_0.05)] px-[9px] py-[3px] text-[11px] font-bold">
                      Yours
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
              withdraws the authority at AiKi, so it stops for good rather than for now. Neither
              currently sends a transaction: the enforcer contracts that would let a revocation
              survive AiKi disappearing are written and tested but not yet deployed, and this page
              will say so plainly until they are.
            </p>
          </>
        )}
      </div>

      {confirming ? (
        <ConfirmDialog
          title={`Revoke ${AGENT_BY_KEY[confirming].name}?`}
          body={`This withdraws the authority at AiKi. It cannot be undone and ${AGENT_BY_KEY[confirming].name} stops for good. It does not yet send a transaction, so it does not survive AiKi disappearing; pausing and revoking differ today in permanence, not in where they are enforced.`}
          alternative="If you only want it to stop for now, pause instead. That is instant, free, and reversible."
          alternativeLabel="Pause instead"
          confirmLabel="Withdraw authority"
          onCancel={() => setConfirming(null)}
          onAlternative={() => {
            const name = AGENT_BY_KEY[confirming].name
            pause(confirming)
            setConfirming(null)
            say(`${name} paused. Nothing was sent, nothing was spent.`)
          }}
          onConfirm={() => {
            const name = AGENT_BY_KEY[confirming].name
            void revoke(confirming)
              .then(() => say(`${name} withdrawn. AiKi will not relay for it again.`))
              .catch(() => say(`Could not withdraw ${name}. Nothing changed; try again.`))
            setConfirming(null)
          }}
        />
      ) : null}
    </PageCard>
  )
}
