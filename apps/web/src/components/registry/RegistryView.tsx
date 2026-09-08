'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { AgentCell, Cell, DataTable, RowActions } from '@/components/shell/DataTable'
import { PageCard } from '@/components/shell/PageCard'
import { LIVENESS_LABEL, LivenessBadge } from '@/components/ui/LivenessBadge'
import { api } from '@/lib/api'
import { useRegistryCoverage } from '@/lib/live'
import { route } from '@/lib/routes'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: ProjectedPassport[] }
  | { kind: 'unreachable' }

/**
 * The registry as we measured it: only the agents that answered at all.
 *
 * Defaulting to the full 1,100-row graveyard would bury the eleven real rows
 * under a thousand dead ones; the graveyard is still counted, on this page and
 * in every coverage block, because hiding it would be the other kind of lie.
 */
export function RegistryView() {
  const router = useRouter()
  const coverage = useRegistryCoverage()
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    api
      .search({ filters: { liveness: ['LIVE', 'DEGRADED'] }, limit: 100 })
      .then((response) => {
        if (!alive) return
        const rows = [...response.results].sort(
          (a, b) =>
            (a.liveness === 'LIVE' ? 0 : 1) - (b.liveness === 'LIVE' ? 0 : 1) ||
            b.checks.trials - a.checks.trials,
        )
        setState({ kind: 'ready', rows })
      })
      .catch(() => alive && setState({ kind: 'unreachable' }))
    return () => {
      alive = false
    }
  }, [])

  const silent = coverage.probed - coverage.answering

  return (
    <PageCard
      title="Registry"
      /*
       * Counted from the aggregate, never from the rows this page happened to
       * fetch. `state.rows` is one capped page of a search; printing its length
       * as "answering" made the headline disagree with the footer below it,
       * which does use the aggregate, and the two did not add up to the total.
       * A number rendered next to a measurement has to be that measurement.
       */
      count={
        coverage.freshness === 'asking'
          ? 'reading the evidence store'
          : `${coverage.answering.toLocaleString()} answering of ${coverage.probed.toLocaleString()} probed`
      }
      tabs={[]}
      tabHint=""
    >
      {state.kind === 'unreachable' ? (
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-5">
          <div className="text-[14.5px] font-bold">The evidence API is not answering.</div>
          <p className="text-muted mt-[5px] mb-0 max-w-[620px] text-[13px] leading-[1.55] text-pretty">
            This page only shows measurements, so with the API unreachable there is nothing honest
            to put here. The Explore page still carries the last sweep's coverage numbers.
          </p>
        </div>
      ) : state.kind === 'loading' ? (
        <div className="text-muted px-1 py-6 text-[13px]">Reading the evidence store…</div>
      ) : (
        <>
          <DataTable
            cols="minmax(190px,1.4fr) minmax(140px,1fr) minmax(120px,0.9fr) 110px 120px"
            minWidth="720px"
            columns={[
              { label: 'Agent', glyph: '◍' },
              { label: 'State we measured', glyph: '⊘' },
              { label: 'Probes answered', glyph: '⊞' },
              { label: 'p95 latency', glyph: '⌁' },
              { label: '', glyph: '', align: 'end' },
            ]}
            rows={state.rows.map((p) => ({
              id: p.agentId,
              cells: [
                <AgentCell
                  key="a"
                  initial="#"
                  name={p.name ?? `Agent #${p.agentId}`}
                  sub={`token ${p.identity.tokenId}`}
                  bg="linear-gradient(135deg,#3D3D3A,#6B6B66)"
                />,
                <LivenessBadge key="b" state={p.liveness} />,
                <Cell key="c" color="var(--color-body)">
                  {p.checks.successes} of {p.checks.trials}
                </Cell>,
                <Cell key="d" weight={700} color="var(--color-ink-app)">
                  {p.p95LatencyMs === null ? 'n/a' : `${(p.p95LatencyMs / 1000).toFixed(1)}s`}
                </Cell>,
                <RowActions
                  key="e"
                  actions={[
                    {
                      label: 'Evidence',
                      primary: true,
                      onClick: () => router.push(route(`/registry/${p.agentId}`)),
                    },
                  ]}
                />,
              ],
            }))}
            footnote={`Ranked by what answered, then by how often we probed it. ${LIVENESS_LABEL.DEGRADED} means it answered, slowly.`}
          />
          <p className="text-muted mt-[14px] mb-0 text-[12.5px] leading-[1.55] text-pretty">
            The other <b className="text-ink-app font-bold">{silent.toLocaleString()}</b> probed
            agents did not answer like agents at all. They are counted in every coverage block
            rather than listed here, because a page of dead rows helps nobody choose.
          </p>
        </>
      )}
    </PageCard>
  )
}
