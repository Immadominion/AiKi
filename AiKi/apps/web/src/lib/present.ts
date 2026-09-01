import type { Tone } from '@/components/ui/StatusPill'
import type { AgentKey } from '@/lib/agents'
import { AGENT_BY_KEY } from '@/lib/agents'
import type { ActivityEvent, Hire, Job, ListingKey } from '@/mock/types'
import { usd } from '@/mock/types'

/**
 * Turning mock state into the shapes the screens already render.
 *
 * Kept apart from both so the screens never learn the store's field names — the
 * day apps/api replaces the store, this file is what changes.
 */
export interface HiredRow {
  key: ListingKey
  initial: string
  name: string
  sub: string
  status: string
  tone: Tone
  spent: string
  cap: string
  pct: string
  hot: boolean
  position: string
  positionStrong: boolean
  action: 'Pause' | 'Resume'
  jobId: string
  expires: string
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

const ago = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const SUB: Record<string, string> = {
  guardian: 'Protecting your Venus loan',
  sentinel: 'Alerts only, no spending',
  lpilot: 'Keeping your position in range',
  gridly: 'Managing BNB / USDT',
  yieldmax: 'Moving idle USDT',
  harbor: 'Moving idle stablecoins',
}

export function hiredRows(hires: Hire[], jobs: Job[]): HiredRow[] {
  return hires.map((h) => {
    const job = jobs.find((j) => j.id === h.jobId)
    const paused = h.status === 'paused'
    const waiting = job?.status === 'WAITING'
    const pct = h.mandate.capCents ? (h.spentCents / h.mandate.capCents) * 100 : 0
    /*
     * What was hired is recorded on the hire, so this reads the thing itself
     * rather than looking it up in the example table. That lookup is why only
     * six agents could ever appear on these screens.
     */
    const agent = AGENT_BY_KEY[h.key]
    const name = h.name ?? agent?.name ?? `Agent ${h.key}`
    const initial = h.initial ?? agent?.initial ?? h.key.charAt(0).toUpperCase()

    const status = paused
      ? 'Paused by you'
      : waiting
        ? 'Waiting on you'
        : job?.status === 'DONE'
          ? 'All good'
          : 'Working'

    const tone: Tone = paused ? 'idle' : waiting ? 'warn' : job?.status === 'DONE' ? 'good' : 'work'

    const position = paused
      ? `Paused ${ago(job?.updatedAt ?? h.hiredAt)}`
      : waiting
        ? 'Needs your answer before it can continue'
        : job
          ? `${job.title} · acted ${ago(job.updatedAt)}`
          : 'Ready'

    return {
      key: h.key,
      initial,
      name,
      sub: SUB[h.key] ?? `token ${h.key}`,
      status,
      tone,
      spent: usd(h.spentCents),
      cap: usd(h.mandate.capCents),
      pct: `${Math.min(pct, 100).toFixed(1)}%`,
      hot: pct >= 25,
      position,
      positionStrong: !paused && !waiting,
      action: paused ? 'Resume' : 'Pause',
      jobId: h.jobId,
      expires: day(h.mandate.expiresAt),
    }
  })
}

export interface EventRow {
  id: string
  at: string
  key: ListingKey
  initial: string
  name: string
  where: string
  what: string
  cost: string
  result: string
  tone: Tone
}

const RESULT_TONE: Record<ActivityEvent['result'], Tone> = {
  Done: 'good',
  Blocked: 'warn',
  Checked: 'idle',
  Waiting: 'work',
}

export function eventRows(events: ActivityEvent[]): EventRow[] {
  return [...events]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((e) => ({
      id: e.id,
      at: new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      key: e.key,
      initial: AGENT_BY_KEY[e.key]?.initial ?? e.key.charAt(0).toUpperCase(),
      name: AGENT_BY_KEY[e.key]?.name ?? `Agent ${e.key}`,
      where: e.where,
      what: e.what,
      cost: usd(e.costCents),
      result: e.result,
      tone: RESULT_TONE[e.result],
    }))
}
