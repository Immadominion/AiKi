'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'
import { CoverageBlock } from '@/components/shell/CoverageBlock'
import { AgentCell, Cell, DataTable, RowActions } from '@/components/shell/DataTable'
import { PageCard } from '@/components/shell/PageCard'
import { useSaved } from '@/components/shell/prefs'
import { EvidenceBars } from '@/components/ui/EvidenceBars'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENTS } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'
import { useRegistryCoverage } from '@/lib/live'
import { agentHref, route } from '@/lib/routes'
import { search } from '@/lib/search'
import { TASKS } from '@/lib/tasks'

export function ExploreView() {
  const params = useSearchParams()
  const q = params.get('q') ?? ''
  const say = useToast()
  const router = useRouter()
  const { toggle, isSaved } = useSaved()

  const outcome = useMemo(() => search(q), [q])
  const registry = useRegistryCoverage()
  const searching = q.trim().length > 0
  const nothing = searching && outcome.results.length === 0

  // What you actually hold, so "Suggested" means something rather than being a
  // relabelled default sort.
  const suggested = useMemo(() => AGENTS.filter((a) => /venus|pancake/i.test(a.works)), [])
  const testedMost = useMemo(
    () => [...AGENTS].sort((a, b) => DETAILS[b.key].checks[1] - DETAILS[a.key].checks[1]),
    [],
  )

  /**
   * Said on every view of this page, not tucked into a footnote.
   *
   * These six agents are examples. AiKi has never probed them, because they are
   * not in the registry. Matching an ask to an agent needs to know what an agent
   * can do, and almost nothing in the real registry publishes that: of the
   * agents indexed so far, none has resolved a registration file carrying
   * capabilities. So this page demonstrates the shape of the answer while the
   * registry page carries what is actually known.
   */
  const exampleBanner = {
    title: 'These six agents are examples.',
    body: 'AiKi has not probed them and they are not in the ERC-8004 registry. Matching an ask to an agent means knowing what that agent can do, and almost no registry entry publishes it yet, so this page shows the shape of the answer rather than a measured one.',
    cta: 'See what we measured',
    onAction: () => router.push(route('/registry')),
  }

  const table = (rows: typeof AGENTS) => (
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
      rows={rows.map((a) => ({
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
              {
                label: isSaved(a.key) ? 'Saved' : 'Save',
                onClick: () => {
                  toggle(a.key)
                  say(isSaved(a.key) ? `${a.name} removed from saved.` : `${a.name} saved.`)
                },
              },
              { label: 'View', primary: true, onClick: () => router.push(agentHref(a.key)) },
            ]}
          />,
        ],
      }))}
      footnote="Each bar is one batch of checks AiKi ran itself, not a rating and not self-reported uptime. Empty bars mean missing evidence. A new agent is not a bad agent."
    />
  )

  const noMatch = (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-5">
      <div className="flex items-start gap-[11px]">
        <span className="bg-warn-hi mt-px flex size-[22px] flex-none items-center justify-center rounded-[8px] text-[12px] font-extrabold">
          ?
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-bold">No agent here can do that yet.</div>
          <p className="text-muted mt-[5px] mb-0 max-w-[620px] text-[13px] leading-[1.55] text-pretty">
            AiKi claims four kinds of work today. We would rather tell you that than show you agents
            that cannot do this. The ask is logged, because unmet asks are how we know what to add
            next.
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
  )

  return (
    <PageCard
      title={searching ? 'Results' : 'Explore'}
      count={
        searching
          ? outcome.understood
            ? `for “${q}” · read as ${outcome.understood.toLowerCase()}`
            : `for “${q}”`
          : `${AGENTS.length} agents · 4 kinds of work`
      }
      primary="Compare"
      onPrimary={() => router.push(route('/compare?agents=guardian,sentinel'))}
      tabs={searching ? [] : ['Suggested', 'All', 'Tested most']}
      tabHint={
        searching
          ? ''
          : [
              'Matched against the positions you hold',
              'Everything we index that answers at all',
              'Most checks we have run, first',
            ]
      }
      banner={exampleBanner}
      panels={searching ? undefined : [table(suggested), table(AGENTS), table(testedMost)]}
    >
      {searching ? (
        <>
          <div className="mb-[18px]">
            <CoverageBlock shown={outcome.results.length} coverage={registry} />
          </div>
          {nothing ? noMatch : table(outcome.results)}
        </>
      ) : null}
    </PageCard>
  )
}
