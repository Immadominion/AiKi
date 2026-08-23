'use client'

import type { ActivityEvent } from '@/mock/types'
import { usd } from '@/mock/types'

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
 * A refusal is the most valuable thing that can appear here — it is the safety
 * layer visibly working, and the moment a user learns their limits are real. It
 * gets the loudest treatment on the page. A routine check gets almost none:
 * announcing every permitted action trains people to ignore the row that
 * matters.
 */
function Row({ event }: { event: ActivityEvent }) {
  const stamp = (
    <span className="text-faint w-[62px] flex-none text-[11.5px] font-semibold tabular-nums">
      {time(event.at)}
    </span>
  )

  if (event.result === 'Blocked') {
    return (
      <div className="flex items-start gap-3 py-[9px]">
        {stamp}
        <span className="bg-work mt-[5px] size-[7px] flex-none rounded-full" />
        <span className="bg-work-bg min-w-0 flex-1 rounded-[14px] px-[13px] py-[11px]">
          <span className="text-work-ink block text-[13px] font-bold">Stopped by your limit</span>
          <span className="mt-[3px] block text-[12.5px] leading-[1.5] text-pretty text-[#7A3A14]">
            {event.what}
          </span>
          {event.rule ? (
            <span className="text-faint mt-[6px] block font-mono text-[11px]">{event.rule}</span>
          ) : null}
        </span>
      </div>
    )
  }

  if (event.result === 'Done') {
    return (
      <div className="flex items-start gap-3 py-[9px]">
        {stamp}
        <span className="bg-good mt-[6px] size-[7px] flex-none rounded-full" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-pretty">{event.what}</span>
          <span className="text-muted mt-[3px] flex flex-wrap items-center gap-x-[10px] gap-y-[2px] text-[11.5px]">
            {event.txHash ? <span className="font-mono">{short(event.txHash)}</span> : null}
            {event.costCents ? <span>gas {usd(event.costCents)}</span> : null}
          </span>
        </span>
      </div>
    )
  }

  if (event.result === 'Waiting') {
    return (
      <div className="flex items-start gap-3 py-[9px]">
        {stamp}
        <span className="bg-warn mt-[6px] size-[7px] flex-none rounded-full" />
        <span className="min-w-0 flex-1 text-[13px] leading-[1.45] font-semibold text-pretty">
          {event.what}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 py-[7px]">
      {stamp}
      <span className="mt-[6px] size-[7px] flex-none rounded-full bg-[rgb(26_26_25_/_0.15)]" />
      <span className="text-muted min-w-0 flex-1 text-[12.5px] leading-[1.45] text-pretty">
        {event.what}
      </span>
    </div>
  )
}

export function EventStream({ events, live }: { events: ActivityEvent[]; live: boolean }) {
  if (!events.length && !live) {
    return (
      <div className="text-muted py-[14px] text-[12.5px]">
        Nothing yet. This fills in as the agent works.
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {events.map((e) => (
        <Row key={e.id} event={e} />
      ))}
      {live ? (
        <div className="flex items-center gap-3 py-[9px]">
          <span className="w-[62px] flex-none" />
          <span className="animate-breathe bg-orange-app size-[7px] flex-none rounded-full" />
          <span className="text-muted text-[12.5px] font-semibold">Working…</span>
        </div>
      ) : null}
    </div>
  )
}
