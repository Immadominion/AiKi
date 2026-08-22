'use client'

import type { JobEvent } from '@aiki/contracts'
import { useEffect, useState } from 'react'
import type { StreamedEvent } from '@/lib/job'

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`

/**
 * One event, drawn according to what it is.
 *
 * A policy DENY is the most valuable thing that can appear here — it is the
 * safety layer visibly working, and the moment a user learns their limits are
 * real. It gets the loudest treatment on the page. An ALLOW gets almost none:
 * announcing every permitted action trains people to ignore the row that matters.
 */
function Row({ event }: { event: JobEvent }) {
  const stamp = (
    <span className="text-faint w-[62px] flex-none text-[11.5px] font-semibold tabular-nums">
      {time(event.at)}
    </span>
  )

  if (event.type === 'policy' && event.decision === 'deny') {
    return (
      <div className="flex items-start gap-3 py-[9px]">
        {stamp}
        <span className="bg-work mt-[5px] size-[7px] flex-none rounded-full" />
        <span className="bg-work-bg min-w-0 flex-1 rounded-[14px] px-[13px] py-[11px]">
          <span className="text-work-ink block text-[13px] font-bold">Stopped by your limit</span>
          <span className="mt-[3px] block text-[12.5px] leading-[1.5] text-pretty text-[#7A3A14]">
            {event.reason}
          </span>
          <span className="text-faint mt-[6px] block font-mono text-[11px]">{event.rule}</span>
        </span>
      </div>
    )
  }

  if (event.type === 'policy') {
    return (
      <div className="flex items-start gap-3 py-[7px]">
        {stamp}
        <span className="mt-[6px] size-[7px] flex-none rounded-full bg-[rgb(26_26_25_/_0.13)]" />
        <span className="text-muted min-w-0 flex-1 text-[12.5px] leading-[1.45] text-pretty">
          Checked against your limits — allowed. <span className="text-faint">{event.reason}</span>
        </span>
      </div>
    )
  }

  if (event.type === 'onchain') {
    return (
      <div className="flex items-start gap-3 py-[9px]">
        {stamp}
        <span className="bg-good mt-[6px] size-[7px] flex-none rounded-full" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold">{event.action}</span>
          <span className="text-muted mt-[3px] flex flex-wrap items-center gap-x-[10px] gap-y-[2px] text-[11.5px]">
            <span className="font-mono">{short(event.txHash)}</span>
            <span>gas ${event.gas.displayUsd}</span>
          </span>
        </span>
      </div>
    )
  }

  if (event.type === 'spend') {
    return (
      <div className="flex items-start gap-3 py-[7px]">
        {stamp}
        <span className="bg-orange-app mt-[6px] size-[7px] flex-none rounded-full" />
        <span className="min-w-0 flex-1 text-[12.5px]">
          Spent <b className="font-bold tabular-nums">${event.amount.displayUsd}</b>
          <span className="text-muted"> · ${event.runningTotal.displayUsd} this month</span>
        </span>
      </div>
    )
  }

  if (event.type === 'status') {
    return (
      <div className="flex items-start gap-3 py-[7px]">
        {stamp}
        <span className="mt-[6px] size-[7px] flex-none rounded-full bg-[rgb(26_26_25_/_0.13)]" />
        <span className="text-muted min-w-0 flex-1 text-[12.5px] font-semibold">
          {event.status.charAt(0) + event.status.slice(1).toLowerCase()}
        </span>
      </div>
    )
  }

  if (event.type === 'error') {
    return (
      <div className="flex items-start gap-3 py-[9px]">
        {stamp}
        <span className="bg-warn mt-[6px] size-[7px] flex-none rounded-full" />
        <span className="min-w-0 flex-1 text-[12.5px] leading-[1.45]">
          {event.message}{' '}
          {event.retryable ? <span className="text-muted">· will retry</span> : null}
        </span>
      </div>
    )
  }

  if (event.type === 'approval_required') return null

  return (
    <div className="flex items-start gap-3 py-[9px]">
      {stamp}
      <span className="mt-[6px] size-[7px] flex-none rounded-full bg-[rgb(26_26_25_/_0.2)]" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold">{event.label}</span>
        {event.detail ? (
          <span className="text-muted mt-[3px] block text-[12.5px] leading-[1.45] text-pretty">
            {event.detail}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/**
 * Replays the stream so the page feels live.
 *
 * Once a line is on screen it stays there. A job's history is the product, not a
 * view that refreshes — losing an event to a re-render would lose the only record
 * the user has that something was stopped.
 */
export function EventStream({
  events,
  onApproval,
}: {
  events: StreamedEvent[]
  onApproval: (e: Extract<JobEvent, { type: 'approval_required' }>) => void
}) {
  const [shown, setShown] = useState(1)

  useEffect(() => {
    if (shown >= events.length) return
    const next = events[shown]?.event
    const id = setTimeout(() => {
      if (next?.type === 'approval_required') onApproval(next)
      setShown((n) => n + 1)
    }, 900)
    return () => clearTimeout(id)
  }, [shown, events, onApproval])

  return (
    <div className="flex flex-col">
      {events.slice(0, shown).map(({ seq, event }) => (
        <Row key={seq} event={event} />
      ))}
      {shown < events.length ? (
        <div className="flex items-center gap-3 py-[9px]">
          <span className="w-[62px] flex-none" />
          <span className="animate-breathe bg-orange-app size-[7px] flex-none rounded-full" />
          <span className="text-muted text-[12.5px] font-semibold">Working…</span>
        </div>
      ) : null}
    </div>
  )
}
