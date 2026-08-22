'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG } from '@/lib/agents'
import { route } from '@/lib/routes'

const CHIPS = [
  { label: 'Last 7 days', glyph: '◷', msg: 'Date range picker is wired in the build.' },
  { label: 'All protocols', glyph: '⊞', msg: 'Protocol filter is wired in the build.' },
]

const LIVE = [
  {
    initial: 'G',
    name: 'Guardian',
    state: 'All good',
    pillBg: 'var(--color-good-bg)',
    pillFg: 'var(--color-good-ink)',
    detail: 'Health factor 1.82 · $14.20 of $250',
    pct: '5.7%',
    bg: AGENT_BG.guardian,
  },
  {
    initial: 'G',
    name: 'Gridly',
    state: 'Rebalancing',
    pillBg: 'var(--color-work-bg)',
    pillFg: 'var(--color-work-ink)',
    detail: 'In range · $31.80 of $120',
    pct: '26.5%',
    bg: AGENT_BG.gridly,
  },
]

/**
 * What is waiting for you.
 *
 * Ordered by what it costs to miss, not by time. An approval that expires is
 * the only kind of notification here that has a deadline, so it sits above a
 * blocked action that has already been handled by the limit doing its job.
 */
interface Note {
  id: string
  tone: 'warn' | 'work' | 'good'
  title: string
  body: string
  when: string
  href: string
}

const NOTES: Note[] = [
  {
    id: 'n1',
    tone: 'work',
    title: 'YieldMax is waiting on you',
    body: 'It found 11.8% APY and needs approval before moving anything.',
    when: '09:03',
    href: '/jobs/job_01J8',
  },
  {
    id: 'n2',
    tone: 'warn',
    title: 'An action was blocked overnight',
    body: 'Guardian tried to spend $91.20 against your $80 per-action limit. Nothing was spent.',
    when: '02:41',
    href: '/activity',
  },
  {
    id: 'n3',
    tone: 'good',
    title: 'Guardian finished a job',
    body: 'Health factor 1.19 → 1.51. The receipt is signed and ready.',
    when: '02:41',
    href: '/receipts/rcp_01J8',
  },
]

const DOT: Record<Note['tone'], string> = {
  warn: 'var(--color-warn)',
  work: 'var(--color-work)',
  good: 'var(--color-good)',
}

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const [open, setOpen] = useState(false)
  const [bell, setBell] = useState(false)
  const [read, setRead] = useState<Record<string, boolean>>({})
  const say = useToast()

  const unread = NOTES.filter((n) => !read[n.id]).length

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

      <div
        title="0x7f4a…3a91"
        className="hidden h-11 flex-none items-center gap-2 rounded-[15px] bg-white px-2 shadow-[0_1px_2px_rgb(26_26_25_/_0.06)] sm:flex"
      >
        <Image
          src="/aiki-logo.png"
          alt=""
          width={56}
          height={56}
          className="size-7 object-contain"
        />
        <span className="hidden text-[14px] font-bold whitespace-nowrap lg:block">0x7f4a…3a91</span>
      </div>

      {CHIPS.map((c) => (
        <button
          key={c.label}
          type="button"
          title={c.label}
          onClick={() => say(c.msg)}
          className="hidden h-11 flex-none items-center gap-[9px] rounded-[15px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[14px] font-semibold whitespace-nowrap hover:bg-[rgb(26_26_25_/_0.09)] sm:flex lg:px-[15px]"
        >
          <span className="w-4 flex-none text-center text-[13px] text-[#77776F]">{c.glyph}</span>
          <span className="hidden whitespace-nowrap lg:inline">{c.label}</span>
          <span className="text-muted hidden text-[11px] lg:inline">⌄</span>
        </button>
      ))}

      <div className="flex-1" />

      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o)
            setBell(false)
          }}
          className="flex h-11 flex-none items-center gap-[10px] rounded-[15px] border-0 bg-white pr-2 pl-[15px] text-[14px] font-semibold whitespace-nowrap shadow-[0_1px_2px_rgb(26_26_25_/_0.06)] hover:shadow-[0_4px_14px_-4px_rgb(26_26_25_/_0.16)]"
        >
          <span className="animate-breathe bg-good size-2 rounded-full" />
          <span className="whitespace-nowrap">
            2 agents<span className="hidden lg:inline"> · all good</span>
          </span>
          <span className="flex size-[26px] items-center justify-center rounded-[9px] bg-[rgb(26_26_25_/_0.055)] text-[11px] text-[#77776F]">
            {open ? '×' : '⌄'}
          </span>
        </button>

        {open && (
          <div className="animate-rise fixed inset-x-2 top-[68px] z-60 overflow-hidden rounded-[20px] bg-white shadow-[0_24px_60px_-20px_rgb(26_26_25_/_0.3),0_1px_2px_rgb(26_26_25_/_0.08)] sm:absolute sm:inset-x-auto sm:top-[52px] sm:right-0 sm:w-[392px]">
            <div className="flex items-center justify-between px-4 pt-[15px] pb-3">
              <span className="text-[14.5px] font-bold">Working for you</span>
              <span className="text-muted text-[12px] font-semibold">
                $46.00 of $370 this month
              </span>
            </div>

            {LIVE.map((a) => (
              <div
                key={a.name}
                className="flex items-center gap-3 border-t border-[rgb(26_26_25_/_0.06)] px-4 py-3"
              >
                <span
                  className="flex size-[38px] flex-none items-center justify-center rounded-xl text-[15px] font-extrabold text-white"
                  style={{ background: a.bg }}
                >
                  {a.initial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-[7px]">
                    <span className="text-[14px] font-bold">{a.name}</span>
                    <span
                      className="rounded-full px-[7px] py-[2px] text-[10.5px] font-bold"
                      style={{ background: a.pillBg, color: a.pillFg }}
                    >
                      {a.state}
                    </span>
                  </span>
                  <span className="text-muted mt-[3px] block text-[12px]">{a.detail}</span>
                  <span className="mt-[7px] block h-[5px] overflow-hidden rounded-full bg-[rgb(26_26_25_/_0.07)]">
                    <span
                      className="bg-orange-app block h-full rounded-full"
                      style={{ width: a.pct }}
                    />
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => say(`Pause is instant and free — ${a.name} stops within seconds.`)}
                  className="h-8 flex-none rounded-[10px] border-0 bg-[rgb(26_26_25_/_0.055)] px-[13px] text-[12.5px] font-semibold hover:bg-[rgb(26_26_25_/_0.09)]"
                >
                  Pause
                </button>
              </div>
            ))}

            <div className="bg-warn-bg mx-4 mt-3 mb-[14px] flex items-start gap-[10px] rounded-[15px] px-[13px] py-3">
              <span className="bg-warn flex size-[19px] flex-none items-center justify-center rounded-[7px] text-[11px] font-extrabold text-white">
                !
              </span>
              <span className="text-[12px] leading-[1.5] text-[#6B5A34]">
                Overnight, Guardian tried to spend <b>$91.20</b> — over your $80 per-action limit.
                AiKi stopped it. Nothing was spent.
              </span>
            </div>

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
          title={unread ? `Notifications — ${unread} unread` : 'Notifications'}
          onClick={() => {
            setBell((b) => !b)
            setOpen(false)
          }}
          className="relative flex size-11 flex-none items-center justify-center rounded-[15px] border-0 bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)] hover:shadow-[0_4px_14px_-4px_rgb(26_26_25_/_0.16)]"
        >
          <span className="size-[14px] rounded-t-[6px] rounded-b-[3px] border-[1.8px] border-[#4A4A46]" />
          {unread ? (
            <span className="bg-orange-app absolute top-[9px] right-[10px] size-2 rounded-full border-2 border-white" />
          ) : null}
        </button>

        {bell ? (
          <div className="animate-rise fixed inset-x-2 top-[68px] z-60 overflow-hidden rounded-[20px] bg-white shadow-[0_24px_60px_-20px_rgb(26_26_25_/_0.3),0_1px_2px_rgb(26_26_25_/_0.08)] sm:absolute sm:inset-x-auto sm:top-[52px] sm:right-0 sm:w-[376px]">
            <div className="flex items-center justify-between px-4 pt-[15px] pb-3">
              <span className="text-[14.5px] font-bold">
                {unread ? `${unread} waiting` : 'Nothing waiting'}
              </span>
              {unread ? (
                <button
                  type="button"
                  onClick={() => setRead(Object.fromEntries(NOTES.map((n) => [n.id, true])))}
                  className="text-muted hover:text-ink-app border-0 bg-none text-[12px] font-semibold"
                >
                  Mark all read
                </button>
              ) : null}
            </div>

            {NOTES.map((n) => (
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
              Blocked actions are kept here on purpose. They are the proof your limits hold.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
