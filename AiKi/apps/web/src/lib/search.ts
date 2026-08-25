import { AGENTS, type AgentRow } from './agents'
import { AGENTS_FOR, matchTasks } from './tasks'

export interface SearchOutcome {
  query: string
  /** The kind of work we understood the query to be about, if any. */
  understood: string | null
  results: AgentRow[]
}

export function search(query: string): SearchOutcome {
  const q = query.trim()
  if (!q) return { query: '', understood: null, results: AGENTS }

  const tasks = matchTasks(q)
  const understood = tasks[0]?.title ?? null

  // Agents are matched on the work they do, not on string similarity to their
  // name — someone asking to avoid liquidation should not be shown an agent
  // called "Liquidator".
  const results = tasks.length
    ? AGENTS.filter((a) => tasks.some((t) => AGENTS_FOR[t.key]?.includes(a.key)))
    : []

  return { query: q, understood, results }
}
