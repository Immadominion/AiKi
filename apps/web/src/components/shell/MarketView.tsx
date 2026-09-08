'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { MarketGrid } from '@/components/shell/MarketCard'
import { PageCard } from '@/components/shell/PageCard'
import { useLayoutPref } from '@/components/shell/prefs'
import type { AgentRow } from '@/lib/agents'
import { api } from '@/lib/api'
import { FAST_HOME } from '@/lib/routes'

/**
 * The market home: the alternative to the single question.
 *
 * This is where Manual mode lands, so it is the browsing surface for somebody
 * who arrives without a task in mind and reads descriptions. It used to show
 * the same six examples as Explore, behind a banner saying so. The banner's
 * reason was that almost no registry entry publishes what an agent can do, and
 * that stopped being true: registrations carry a description, and the
 * marketplace ranks on it, so this page can browse the real thing.
 */

/** One card per distinct name: 90 of the 243 answering agents are one fleet. */
function distinct(passports: readonly ProjectedPassport[]): ProjectedPassport[] {
  const seen = new Set<string>()
  const kept: ProjectedPassport[] = []
  for (const p of passports) {
    const key = (p.name ?? p.agentId).trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(p)
  }
  return kept
}

function toRow(p: ProjectedPassport): AgentRow {
  const display = (p.name ?? `Agent ${p.agentId}`).replace(/^AiKi\s+/i, '')
  const trials = p.checks?.trials ?? 0
  const answering = p.liveness === 'LIVE'
  const description = (p.description ?? '').trim()
  const sentence = description ? (description.split(/(?<=\.)\s/)[0] ?? description) : ''
  return {
    // AgentRow.key types as AgentKey for the examples; a token id is the real
    // identity and the grid only ever uses it as a react key and a route.
    key: p.agentId as AgentRow['key'],
    initial: (display.charAt(0) || '?').toUpperCase(),
    name: display,
    works: `token ${p.agentId}`,
    does: sentence || 'Declares no description',
    blurb: sentence || 'This agent publishes no description of what it does.',
    // One bar per batch of checks, capped, so the bars mean the same thing they
    // mean everywhere else: how much we have actually watched it.
    bars: answering ? Math.min(5, Math.max(1, Math.round(trials / 6))) : 1,
    evidence: answering
      ? `Answering · ${trials} ${trials === 1 ? 'check' : 'checks'}`
      : `${p.liveness.replace(/_/g, ' ').toLowerCase()} · ${trials} ${trials === 1 ? 'check' : 'checks'}`,
    evidenceTone: answering ? (trials >= 20 ? 'strong' : 'fair') : 'thin',
    // Almost nothing in this registry publishes a price, and a blank that reads
    // as free is worse than saying so.
    price: 'No published price',
  }
}

export function MarketView() {
  const { layout } = useLayoutPref()
  const router = useRouter()
  const fast = layout === 'fast'

  const [rows, setRows] = useState<AgentRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    api
      .search({ limit: 60 })
      .then((answer) => {
        if (!cancelled) setRows(distinct(answer.results).slice(0, 12).map(toRow))
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PageCard
      title="Home"
      count={fast ? 'Fast mode is your home' : 'Manual mode is your home'}
      primary={fast ? 'Open Fast mode' : undefined}
      onPrimary={fast ? () => router.push(FAST_HOME) : undefined}
      tabs={[]}
      tabHint=""
    >
      {failed ? (
        <p className="max-w-[620px] text-[13.5px]">
          The registry could not be reached, so there is nothing to browse yet. This page will not
          fill itself with examples in the meantime.
        </p>
      ) : rows === null ? (
        <p className="text-muted text-[13.5px]">Reading the registry…</p>
      ) : (
        <MarketGrid
          agents={rows}
          footnote="Every agent here answered a probe AiKi ran itself. The count on each card is how many it has answered, and the description is the operator's own wording from their registration."
        />
      )}
    </PageCard>
  )
}
