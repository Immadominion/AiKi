'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'
import { CoverageBlock } from '@/components/shell/CoverageBlock'
import { AgentCell, Cell, DataTable, RowActions } from '@/components/shell/DataTable'
import { PageCard } from '@/components/shell/PageCard'
import { EvidenceBars } from '@/components/ui/EvidenceBars'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG } from '@/lib/agents'
import { agentHref, route } from '@/lib/routes'
import { search } from '@/lib/search'
import { TASKS } from '@/lib/tasks'

export function ExploreView() {
  const params = useSearchParams()
  const q = params.get('q') ?? ''
  const say = useToast()
  const router = useRouter()

  const outcome = useMemo(() => search(q), [q])
  const searching = q.trim().length > 0
  const nothing = searching && outcome.results.length === 0

  return (
    <PageCard
      title={searching ? 'Results' : 'Explore'}
      count={
        searching
          ? outcome.understood
            ? `for “${q}” · read as ${outcome.understood.toLowerCase()}`
            : `for “${q}”`
          : '12 agents · 4 kinds of work'
      }
      primary="Compare"
      onPrimary={() => router.push(route('/compare?agents=guardian,sentinel'))}
      tabs={searching ? [] : ['Suggested', 'All', 'Tested most']}
      tabHint={searching ? '' : 'Ranked by evidence AiKi collected itself'}
      banner={
        searching
          ? undefined
          : {
              title: 'Suggested for your positions.',
              body: 'You hold a Venus loan and a BNB / USDT pool — these four agents claim exactly that work.',
              cta: 'Why these',
              onAction: () =>
                say('Ranked on your open positions and the evidence AiKi collected itself.'),
            }
      }
    >
      {searching ? (
        <div className="mb-[18px]">
          <CoverageBlock coverage={outcome.coverage} />
        </div>
      ) : null}

      {nothing ? (
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-5">
          <div className="flex items-start gap-[11px]">
            <span className="bg-warn-hi mt-px flex size-[22px] flex-none items-center justify-center rounded-[8px] text-[12px] font-extrabold">
              ?
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14.5px] font-bold">No agent here can do that yet.</div>
              <p className="text-muted mt-[5px] mb-0 max-w-[620px] text-[13px] leading-[1.55] text-pretty">
                AiKi claims four kinds of work today. We would rather tell you that than show you
                agents that cannot do this — and the ask is logged, because unmet asks are how we
                know what to add next.
              </p>

              <div className="mt-[14px] flex flex-wrap gap-[8px]">
                {TASKS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => router.push(route(`/explore?q=${encodeURIComponent(t.intent)}`))}
                    className="flex items-center gap-[9px] rounded-[13px] border border-[rgb(26_26_25_/_0.08)] px-[11px] py-[9px] text-left hover:bg-[rgb(26_26_25_/_0.035)]"
                  >
                    <span
                      className="flex size-[26px] flex-none items-center justify-center rounded-[9px] text-[11px] font-extrabold text-white"
                      style={{ background: t.bg }}
                    >
                      {t.glyph}
                    </span>
                    <span className="text-[13px] font-semibold">{t.title}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <DataTable
          cols="minmax(200px,1.5fr) minmax(150px,1.1fr) minmax(180px,1.3fr) 100px 152px"
          minWidth="790px"
          columns={[
            { label: 'Agent', glyph: '◍' },
            { label: 'What it does', glyph: '⌬' },
            { label: 'Evidence AiKi collected', glyph: '⊞', sortable: true },
            { label: 'Price', glyph: '⌁', sortable: true },
            { label: '', glyph: '', align: 'end' },
          ]}
          rows={outcome.results.map((a) => ({
            id: a.key,
            cells: [
              <AgentCell
                key="a"
                initial={a.initial}
                name={a.name}
                sub={a.works}
                bg={AGENT_BG[a.key]}
              />,
              <Cell key="b" color="var(--color-body)">
                {a.does}
              </Cell>,
              <EvidenceBars key="c" filled={a.bars} label={a.evidence} tone={a.evidenceTone} />,
              <Cell key="d" weight={700} color="var(--color-ink-app)">
                {a.price}
              </Cell>,
              <RowActions
                key="e"
                actions={[
                  { label: 'Save', onClick: () => say(`${a.name} saved.`) },
                  { label: 'View', primary: true, onClick: () => router.push(agentHref(a.key)) },
                ]}
              />,
            ],
          }))}
          footnote="Each bar is one batch of checks AiKi ran itself, not a rating and not self-reported uptime. Empty bars mean missing evidence — a new agent is not a bad agent."
        />
      )}
    </PageCard>
  )
}
