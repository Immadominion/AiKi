'use client'

import { CalendarIcon, ChevronDownIcon, LayersIcon } from '@animateicons/react/lucide'
import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { useHoverIcon } from '@/components/ui/AnimatedIcon'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENT_BY_KEY } from '@/lib/agents'
import { hiredRows } from '@/lib/present'
import { route } from '@/lib/routes'
import { CONNECT_TOAST, shortAddress } from '@/lib/wallet'
import { useMock } from '@/mock/store'
import { type MockState, usd } from '@/mock/types'

const CHIPS = [
  { label: 'Last 7 days', icon: CalendarIcon, msg: 'Date range picker is wired in the build.' },
  { label: 'All protocols', icon: LayersIcon, msg: 'Protocol filter is wired in the build.' },
]

/** A filter chip. Owns its icon ref, because the chip is the hover target. */
function Chip({
  label,
  icon: Icon,
  onClick,
}: {
  label: string
  icon: typeof CalendarIcon
  onClick: () => void
}) {
  const { ref, hoverProps } = useHoverIcon()
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="hidden h-11 flex-none items-center gap-[9px] rounded-[15px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[14px] font-semibold whitespace-nowrap hover:bg-[rgb(26_26_25_/_0.09)] sm:flex lg:px-[15px]"
      {...hoverProps}
    >
      <span className="flex flex-none items-center justify-center text-[#57574F] [&_svg]:stroke-[2.25]">
        <Icon ref={ref} size={17} color="currentColor" />
      </span>
      <span className="hidden whitespace-nowrap lg:inline">{label}</span>
      <span className="text-muted hidden flex-none lg:inline [&_svg]:stroke-[2.5]">
        <ChevronDownIcon size={13} color="currentColor" />
      </span>
    </button>
  )
}

/**
 * What is waiting for you.
 *
 * Derived, and ordered by what it costs to miss rather than by time. An
 * approval is the only kind here with a deadline, so it sits above a refusal
 * that has already been handled by the limit doing its job.
 */
interface Note {
  id: string
  tone: 'warn' | 'work' | 'good'
  title: string
  body: string
  when: string
  href: string
}

const DOT: Record<Note['tone'], string> = {
  warn: 'var(--color-warn)',
  work: 'var(--color-work)',
  good: 'var(--color-good)',
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function notesFrom(state: MockState): Note[] {
  const waiting: Note[] = state.jobs
    .filter((j) => j.approval)
    .map((j) => ({
      id: `n-${j.id}`,
      tone: 'work' as const,
      title: `${AGENT_BY_KEY[j.key].name} is waiting on you`,
      body: j.approval?.prompt ?? '',
      when: clock(j.updatedAt),
      href: `/jobs/${j.id}`,
    }))

  const blocked: Note[] = state.events
    .filter((e) => e.result === 'Blocked')
    .slice(-3)
    .reverse()
    .map((e) => ({
      id: `n-${e.id}`,
      tone: 'warn' as const,
      title: 'An action was blocked',
      body: e.what,
      when: clock(e.at),
      href: '/activity',
    }))

  const done: Note[] = state.receipts
    .slice(-2)
    .reverse()
    .map((r) => ({
      id: `n-${r.id}`,
      tone: 'good' as const,
      title: `${AGENT_BY_KEY[r.key].name} finished a job`,
      body: `${r.summary} The receipt is signed and ready.`,
      when: clock(r.completedAt),
      href: `/receipts/${r.id}`,
    }))

  return [...waiting, ...blocked, ...done]
}

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const { state, connect } = useMock()
  const connected = state.connected
  const [open, setOpen] = useState(false)
  const [bell, setBell] = useState(false)
  const [read, setRead] = useState<Record<string, boolean>>({})
  const say = useToast()
  const { pause } = useMock()

  const notes = connected ? notesFrom(state) : []
  const unread = notes.filter((n) => !read[n.id]).length
  const live = hiredRows(state.hires, state.jobs).filter((h) => h.tone !== 'idle')
  const spentCents = state.events.reduce((n, e) => n + e.costCents, 0)
  const allowedCents = state.hires.reduce((n, h) => n + h.mandate.capCents, 0)
  const anyWaiting = state.jobs.some((j) => j.approval)

  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-[9px] px-[2px] pt-[2px]">
      {/* The drawer handle. Only exists where the sidebar does not. */}
      <button
        type="button"
        aria-label="Open navigation"
        onClick={onMenu}
        className="flex size-11 flex-none items-center justify-center gap-[4px] rounded-[15px] border-0 bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)] md:hidden"
      >
        <span className="flex flex-col gap-[3px]">
          <span className="block h-[2px] w-[15px] rounded-full bg-[#4A4A46]" />
          <span className="block h-[2px] w-[15px] rounded-full bg-[#4A4A46]" />
          <span className="block h-[2px] w-[15px] rounded-full bg-[#4A4A46]" />
        </span>
      </button>

      {connected ? (
        <div
          title={state.address}
          className="hidden h-11 flex-none items-center gap-2 rounded-[15px] bg-white px-2 shadow-[0_1px_2px_rgb(26_26_25_/_0.06)] sm:flex"
        >
          <Image
            src="/aiki-logo.png"
            alt=""
            width={56}
            height={56}
            className="size-7 object-contain"
          />
          <span className="hidden text-[14px] font-bold whitespace-nowrap lg:block">
            {shortAddress(state.address)}
            {state.walletKind === 'simulated' ? (
              <span className="text-muted font-semibold"> · simulated</span>
            ) : null}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            void connect().then((outcome) => say(CONNECT_TOAST[outcome]))
          }}
          className="bg-ink-app hover:bg-orange-app hidden h-11 flex-none items-center rounded-[15px] px-4 text-[13.5px] font-bold whitespace-nowrap text-white transition-colors sm:flex"
        >
          Connect wallet
        </button>
      )}

      {CHIPS.map((c) => (
        <Chip key={c.label} label={c.label} icon={c.icon} onClick={() => say(c.msg)} />
      ))}

      {/* No freshness badge. It used to render LIVE at a hardcoded 42 seconds to
          every signed-in visitor, which is a measurement of nothing presented as
          the age of data. Nothing here reads a balance or a position yet, so
          there is no age to report. */}

      <div className="flex-1" />

      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (!connected || !live.length) return
            setOpen((o) => !o)
            setBell(false)
          }}
          className="flex h-11 flex-none items-center gap-[10px] rounded-[15px] border-0 bg-white pr-2 pl-[15px] text-[14px] font-semibold whitespace-nowrap shadow-[0_1px_2px_rgb(26_26_25_/_0.06)] hover:shadow-[0_4px_14px_-4px_rgb(26_26_25_/_0.16)]"
        >
          <span
            className="size-2 rounded-full"
            style={{
              background:
                !connected || !live.length
                  ? 'var(--color-faint)'
                  : anyWaiting
                    ? 'var(--color-warn)'
                    : 'var(--color-good)',
              animation:
                connected && live.length ? 'aikiBreathe 2.6s ease-in-out infinite' : 'none',
            }}
          />
          <span className="whitespace-nowrap">
            {!connected || !live.length ? (
              'No agents yet'
            ) : (
              <>
                {live.length} agent{live.length === 1 ? '' : 's'}
                <span className="hidden lg:inline">
                  {anyWaiting ? ' · one needs you' : ' · all good'}
                </span>
              </>
            )}
          </span>
          {connected && live.length ? (
            <span className="flex size-[26px] items-center justify-center rounded-[9px] bg-[rgb(26_26_25_/_0.055)] text-[11px] text-[#77776F]">
              {open ? '×' : '⌄'}
            </span>
          ) : null}
        </button>

        {open && (
          <div className="animate-rise fixed inset-x-2 top-[68px] z-60 overflow-hidden rounded-[20px] bg-white shadow-[0_24px_60px_-20px_rgb(26_26_25_/_0.3),0_1px_2px_rgb(26_26_25_/_0.08)] sm:absolute sm:inset-x-auto sm:top-[52px] sm:right-0 sm:w-[392px]">
            <div className="flex items-center justify-between px-4 pt-[15px] pb-3">
              <span className="text-[14.5px] font-bold">Working for you</span>
              <span className="text-muted text-[12px] font-semibold">
                {usd(spentCents)} of {usd(allowedCents)}
              </span>
            </div>

            {live.map((a) => (
              <div
                key={a.name}
                className="flex items-center gap-3 border-t border-[rgb(26_26_25_/_0.06)] px-4 py-3"
              >
                <span
                  className="flex size-[38px] flex-none items-center justify-center rounded-xl text-[15px] font-extrabold text-white"
                  style={{ background: AGENT_BG[a.key] }}
                >
                  {a.initial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-[7px]">
                    <span className="text-[14px] font-bold">{a.name}</span>
                    <span
                      className="rounded-full px-[7px] py-[2px] text-[10.5px] font-bold"
                      style={
                        a.tone === 'warn'
                          ? { background: 'var(--color-warn-bg)', color: 'var(--color-warn-ink)' }
                          : a.tone === 'good'
                            ? { background: 'var(--color-good-bg)', color: 'var(--color-good-ink)' }
                            : { background: 'var(--color-work-bg)', color: 'var(--color-work-ink)' }
                      }
                    >
                      {a.status}
                    </span>
                  </span>
                  <span className="text-muted mt-[3px] block text-[12px]">
                    {a.spent} of {a.cap} · {a.position}
                  </span>
                  <span className="mt-[7px] block h-[5px] overflow-hidden rounded-full bg-[rgb(26_26_25_/_0.07)]">
                    <span
                      className="bg-orange-app block h-full rounded-full"
                      style={{ width: a.pct }}
                    />
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    pause(a.key)
                    say(`${a.name} paused. It stops within seconds and it costs nothing.`)
                  }}
                  className="h-8 flex-none rounded-[10px] border-0 bg-[rgb(26_26_25_/_0.055)] px-[13px] text-[12.5px] font-semibold hover:bg-[rgb(26_26_25_/_0.09)]"
                >
                  Pause
                </button>
              </div>
            ))}

            {notes.some((n) => n.tone === 'warn') ? (
              <div className="bg-warn-bg mx-4 mt-3 mb-[14px] flex items-start gap-[10px] rounded-[15px] px-[13px] py-3">
                <span className="bg-warn flex size-[19px] flex-none items-center justify-center rounded-[7px] text-[11px] font-extrabold text-white">
                  !
                </span>
                <span className="text-[12px] leading-[1.5] text-[#6B5A34]">
                  {notes.find((n) => n.tone === 'warn')?.body}
                </span>
              </div>
            ) : null}

            <Link
              href="/activity"
              onClick={() => setOpen(false)}
              className="block w-full border-t border-[rgb(26_26_25_/_0.06)] p-[13px] text-center text-[13.5px] font-bold hover:bg-[#FAFAF9]"
            >
              See everything they did →
            </Link>
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          title={unread ? `Notifications (${unread} unread)` : 'Notifications'}
          onClick={() => {
            setBell((b) => !b)
            setOpen(false)
          }}
          className="relative flex size-11 flex-none items-center justify-center rounded-[15px] border-0 bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)] hover:shadow-[0_4px_14px_-4px_rgb(26_26_25_/_0.16)]"
        >
          <span className="size-[14px] rounded-t-[6px] rounded-b-[3px] border-[1.8px] border-[#4A4A46]" />
          {connected && unread ? (
            <span className="bg-orange-app absolute top-[9px] right-[10px] size-2 rounded-full border-2 border-white" />
          ) : null}
        </button>

        {bell ? (
          <div className="animate-rise fixed inset-x-2 top-[68px] z-60 overflow-hidden rounded-[20px] bg-white shadow-[0_24px_60px_-20px_rgb(26_26_25_/_0.3),0_1px_2px_rgb(26_26_25_/_0.08)] sm:absolute sm:inset-x-auto sm:top-[52px] sm:right-0 sm:w-[376px]">
            <div className="flex items-center justify-between px-4 pt-[15px] pb-3">
              <span className="text-[14.5px] font-bold">
                {!notes.length ? 'Nothing yet' : unread ? `${unread} waiting` : 'Nothing waiting'}
              </span>
              {unread ? (
                <button
                  type="button"
                  onClick={() => setRead(Object.fromEntries(notes.map((n) => [n.id, true])))}
                  className="text-muted hover:text-ink-app border-0 bg-none text-[12px] font-semibold"
                >
                  Mark all read
                </button>
              ) : null}
            </div>

            {notes.map((n) => (
              <Link
                key={n.id}
                href={route(n.href)}
                onClick={() => {
                  setRead((r) => ({ ...r, [n.id]: true }))
                  setBell(false)
                }}
                className="flex items-start gap-[11px] border-t border-[rgb(26_26_25_/_0.06)] px-4 py-3 hover:bg-[#FAFAF9]"
              >
                <span
                  className="mt-[6px] size-[7px] flex-none rounded-full"
                  style={{ background: read[n.id] ? 'rgb(26 26 25 / 0.15)' : DOT[n.tone] }}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className="block text-[13.5px] leading-[1.35]"
                    style={{ fontWeight: read[n.id] ? 500 : 700 }}
                  >
                    {n.title}
                  </span>
                  <span className="text-muted mt-[3px] block text-[12px] leading-[1.45] text-pretty">
                    {n.body}
                  </span>
                </span>
                <span className="text-faint mt-[2px] flex-none text-[11.5px] font-semibold tabular-nums">
                  {n.when}
                </span>
              </Link>
            ))}

            <div className="text-muted border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[11px] text-[11.5px] leading-[1.45]">
              {notes.length
                ? 'Refusals are kept here on purpose. They are the proof your limits hold.'
                : 'Once an agent is working, anything that needs you, or was refused, appears here.'}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
