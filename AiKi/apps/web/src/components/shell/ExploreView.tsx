'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { paletteFor } from '@/components/home/live-shards'
import { CoverageBlock } from '@/components/shell/CoverageBlock'
import { AgentCell, Cell, DataTable, RowActions } from '@/components/shell/DataTable'
import { PageCard } from '@/components/shell/PageCard'
import { useSaved } from '@/components/shell/prefs'
import { EvidenceBars } from '@/components/ui/EvidenceBars'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENTS } from '@/lib/agents'
import { api } from '@/lib/api'
import { DETAILS } from '@/lib/detail'
import { EXAMPLE_EVIDENCE_COLUMN, EXAMPLE_FOOTNOTE, exampleBanner } from '@/lib/examples'
import { useRegistryCoverage } from '@/lib/live'
import { agentHref, registryHref, route } from '@/lib/routes'
import { TASKS } from '@/lib/tasks'

/**
 * One row, one line of meaning.
 *
 * Registration descriptions run to paragraphs, and one agent's ran long enough
 * to make its row four hundred pixels tall and push every other agent off the
 * screen. The first sentence is taken whole rather than cut mid-word, so what
 * is shown is still the operator's own wording and not our paraphrase of it.
 */
function summarise(description: string | null): string {
  const text = (description ?? '').trim()
  if (!text) return 'Declares no description'
  const first = text.split(/(?<=\.)\s/)[0] ?? text
  return first.length > 150 ? `${first.slice(0, 147).trimEnd()}...` : first
}

export function ExploreView() {
  const params = useSearchParams()
  const q = params.get('q') ?? ''
  const say = useToast()
  const router = useRouter()
  const { toggle, isSaved } = useSaved()

  const registry = useRegistryCoverage()
  const searching = q.trim().length > 0

  /*
   * A search here now asks the marketplace, not the example set.
   *
   * The banner on this page has always said these six are examples, which was
   * honest and was also the whole problem: the reason given was that "almost no
   * registry entry publishes what an agent can do". Registrations do carry a
   * description and service names, and /v1/search now ranks agents on them, so
   * the reason has stopped being true and the page can answer for real.
   *
   * Browsing with no query still shows the examples, still labelled, because
   * there is no measured way to rank agents for somebody who has not said what
   * they want.
   */
  const [live, setLive] = useState<ProjectedPassport[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!searching) return
    let cancelled = false
    setLive(null)
    setFailed(false)
    api
      .search({ query: q, limit: 25 })
      .then((answer) => {
        if (!cancelled) setLive(answer.results)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [q, searching])

  const nothing = searching && live !== null && live.length === 0

  // What you actually hold, so "Suggested" means something rather than being a
  // relabelled default sort.
  const suggested = useMemo(() => AGENTS.filter((a) => /venus|pancake/i.test(a.works)), [])
  const testedMost = useMemo(
    () => [...AGENTS].sort((a, b) => DETAILS[b.key].checks[1] - DETAILS[a.key].checks[1]),
    [],
  )

  // Said on every view of this page, not tucked into a footnote. The wording
  // lives in lib/examples so the four surfaces showing this dataset cannot drift
  // apart again, which is exactly how three of them ended up claiming the
  // opposite.
  const banner = exampleBanner(() => router.push(route('/registry')))

  const table = (rows: typeof AGENTS) => (
    <DataTable
      cols="minmax(200px,1.5fr) minmax(150px,1.1fr) minmax(180px,1.3fr) 100px 152px"
      minWidth="790px"
      columns={[
        { label: 'Agent', glyph: '◍' },
        { label: 'What it does', glyph: '⌬' },
        { label: EXAMPLE_EVIDENCE_COLUMN, glyph: '⊞', sortable: true },
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
      footnote={EXAMPLE_FOOTNOTE}
    />
  )

  /**
   * Real agents, with the evidence AiKi actually holds.
   *
   * No price column: almost nothing in the registry publishes one, and a blank
   * that reads as free is worse than a column that is not there. The evidence
   * cell says the trial count out loud, because a score over three probes and a
   * score over three hundred are different claims.
   */
  const liveTable = (rows: ProjectedPassport[]) => (
    <DataTable
      cols="minmax(200px,1.5fr) minmax(220px,1.6fr) minmax(170px,1.2fr) 152px"
      minWidth="760px"
      columns={[
        { label: 'Agent', glyph: '◍' },
        { label: 'What it says it does', glyph: '⌬' },
        { label: 'What we measured', glyph: '⊞' },
        { label: '', glyph: '', align: 'end' },
      ]}
      rows={rows.map((p) => {
        const trials = p.checks?.trials ?? 0
        const answering = p.liveness === 'LIVE'
        return {
          id: p.agentId,
          cells: [
            <AgentCell
              key="a"
              initial={(p.name ?? p.agentId)
                .replace(/^AiKi\s+/i, '')
                .charAt(0)
                .toUpperCase()}
              name={(p.name ?? `Agent ${p.agentId}`).replace(/^AiKi\s+/i, '')}
              sub={`token ${p.agentId}`}
              bg={paletteFor(p.agentId).bg}
            />,
            <Cell key="b" color="var(--color-body)">
              {summarise(p.description)}
            </Cell>,
            <EvidenceBars
              key="c"
              filled={answering ? Math.min(5, Math.max(1, Math.round(trials / 6))) : 1}
              label={
                answering
                  ? `Answering · ${trials} ${trials === 1 ? 'check' : 'checks'}`
                  : `${p.liveness.replace(/_/g, ' ').toLowerCase()} · ${trials} ${trials === 1 ? 'check' : 'checks'}`
              }
              tone={answering ? (trials >= 20 ? 'strong' : 'fair') : 'thin'}
            />,
            <RowActions
              key="d"
              actions={[
                {
                  label: 'View',
                  primary: true,
                  onClick: () => router.push(registryHref(p.agentId)),
                },
              ]}
            />,
          ],
        }
      })}
      footnote="Ranked on what each agent's own registration says it does, and filtered to the ones that answered a probe. The count beside each is how many probes it has answered."
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
          ? `for “${q}”${live ? ` · ${live.length} from the registry` : ''}`
          : `${AGENTS.length} agents · 4 kinds of work`
      }
      primary="Compare"
      /*
       * Compare what is actually on screen. This always opened the same two
       * example agents, so the button offered to compare a pair the visitor had
       * not searched for and could not see.
       */
      onPrimary={() =>
        router.push(
          route(
            live && live.length >= 2
              ? `/compare?agents=${live[0]?.agentId},${live[1]?.agentId}`
              : '/compare?agents=guardian,sentinel',
          ),
        )
      }
      tabs={searching ? [] : ['Suggested', 'All', 'Tested most']}
      tabHint={
        searching
          ? ''
          : [
              'Matched against the positions you hold',
              'Every example in the set',
              'Most illustrative checks first',
            ]
      }
      banner={searching ? undefined : banner}
      panels={searching ? undefined : [table(suggested), table(AGENTS), table(testedMost)]}
    >
      {searching ? (
        <>
          <div className="mb-[18px]">
            <CoverageBlock shown={live?.length ?? 0} coverage={registry} />
          </div>
          {failed ? (
            <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-5 text-[13.5px]">
              The registry could not be reached, so this page is showing nothing rather than
              guessing. Try again in a moment.
            </div>
          ) : live === null ? (
            <div className="text-muted px-[18px] py-5 text-[13.5px]">Asking the registry…</div>
          ) : nothing ? (
            noMatch
          ) : (
            liveTable(live)
          )}
        </>
      ) : null}
    </PageCard>
  )
}
