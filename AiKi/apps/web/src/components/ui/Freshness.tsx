'use client'

import type { DataState } from '@aiki/contracts'

const TONE: Record<DataState, { dot: string; fg: string; bg: string }> = {
  LIVE: { dot: 'var(--color-good)', fg: 'var(--color-muted)', bg: 'transparent' },
  STALE: { dot: 'var(--color-warn)', fg: 'var(--color-warn-ink)', bg: 'var(--color-warn-bg)' },
  DEGRADED: { dot: 'var(--color-work)', fg: 'var(--color-work-ink)', bg: 'var(--color-work-bg)' },
  NO_DATA: { dot: 'var(--color-faint)', fg: 'var(--color-muted)', bg: 'rgb(26 26 25 / 0.05)' },
}

const age = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

/**
 * How old what you are reading is.
 *
 * Four states rather than two, following Datadog's NO DATA monitor state: an
 * absent number and a stale number are different problems, and collapsing them
 * into "loading" hides the one that should worry you. STALE keeps showing the
 * last known value and says how old it is — replacing a number with a spinner
 * because a refresh failed loses information the reader already had.
 */
export function Freshness({ state, ageMs }: { state: DataState; ageMs?: number }) {
  const t = TONE[state]
  const label =
    state === 'LIVE'
      ? ageMs !== undefined
        ? `Fresh · ${age(ageMs)}`
        : 'Fresh'
      : state === 'STALE'
        ? `Last known · ${ageMs !== undefined ? age(ageMs) : 'older than we would like'}`
        : state === 'DEGRADED'
          ? 'Some sources are down'
          : 'Never measured'

  return (
    <span
      className="inline-flex items-center gap-[7px] rounded-full px-[9px] py-[4px] text-[11.5px] font-semibold whitespace-nowrap"
      style={{ background: t.bg, color: t.fg }}
    >
      <span className="size-[6px] flex-none rounded-full" style={{ background: t.dot }} />
      {label}
    </span>
  )
}
