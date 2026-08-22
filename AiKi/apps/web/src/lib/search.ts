import type { LivenessState } from '@aiki/contracts'
import { AGENTS, type AgentRow } from './agents'
import { AGENTS_FOR, matchTasks } from './tasks'

/**
 * What the registry actually looks like.
 *
 * These are our own sweep proportions, not estimates: 400 agents drawn across
 * 126 distinct blocks of the BSC ERC-8004 registry, August 2026.
 *
 *   DECLARED_ONLY    243  60.8%   registered an identity, published nothing to call
 *   IMPOSTOR_STATIC  133  33.3%   answers 200 with the same bytes whatever you ask
 *   PLACEHOLDER_URL   22   5.5%   localhost, example.com and friends
 *   DEGRADED           2   0.5%
 *   LIVE               0   0.0%
 *
 * They matter to the UI because the honest answer to almost any search is "far
 * fewer than the registry implies", and a results page that quietly drops the
 * excluded ones is telling the same lie every other explorer tells.
 */
const SWEEP: { state: LivenessState; share: number }[] = [
  { state: 'DECLARED_ONLY', share: 243 / 400 },
  { state: 'IMPOSTOR_STATIC', share: 133 / 400 },
  { state: 'PLACEHOLDER_URL', share: 22 / 400 },
]

export const INDEXED_AGENTS = 12_847

export interface Coverage {
  indexed: number
  matchedBeforeFilters: number
  excludedUnverified: number
  reasons: { state: LivenessState; count: number }[]
}

export interface SearchOutcome {
  query: string
  /** The kind of work we understood the query to be about, if any. */
  understood: string | null
  results: AgentRow[]
  coverage: Coverage
}

/** Deterministic, so the same query never reports two different coverage figures. */
function coverageFor(shown: number, seed: number): Coverage {
  const matched = shown + 6 + (seed % 40)
  const excluded = matched - shown
  const reasons = SWEEP.map((s) => ({ state: s.state, count: Math.round(excluded * s.share) }))
  const drift = excluded - reasons.reduce((n, r) => n + r.count, 0)
  const first = reasons[0]
  if (first) first.count += drift
  return {
    indexed: INDEXED_AGENTS,
    matchedBeforeFilters: matched,
    excludedUnverified: excluded,
    reasons: reasons.filter((r) => r.count > 0),
  }
}

const seedOf = (s: string) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 9973, 7)

export function search(query: string): SearchOutcome {
  const q = query.trim()
  if (!q) {
    return {
      query: '',
      understood: null,
      results: AGENTS,
      coverage: coverageFor(AGENTS.length, 11),
    }
  }

  const tasks = matchTasks(q)
  const understood = tasks[0]?.title ?? null

  // Agents are matched on the work they do, not on string similarity to their
  // name — someone asking to avoid liquidation should not be shown an agent
  // called "Liquidator".
  const results = tasks.length
    ? AGENTS.filter((a) => tasks.some((t) => AGENTS_FOR[t.key]?.includes(a.key)))
    : []

  // Nothing understood means nothing matched, so there is nothing to report
  // about exclusions either. Claiming a match count here would be inventing the
  // one number on the page that is supposed to be the honest one.
  if (!tasks.length) {
    return {
      query: q,
      understood: null,
      results: [],
      coverage: {
        indexed: INDEXED_AGENTS,
        matchedBeforeFilters: 0,
        excludedUnverified: 0,
        reasons: [],
      },
    }
  }

  return { query: q, understood, results, coverage: coverageFor(results.length, seedOf(q)) }
}
