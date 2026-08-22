'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG } from '@/lib/agents'

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

export function TopBar() {
  const [open, setOpen] = useState(false)
  const say = useToast()

  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-[9px] px-[2px] pt-[2px]">
      <div
        title="0x7f4a…3a91"
        className="flex h-11 flex-none items-center gap-2 rounded-[15px] bg-white px-2 shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]"
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
          className="flex h-11 flex-none items-center gap-[9px] rounded-[15px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[14px] font-semibold whitespace-nowrap hover:bg-[rgb(26_26_25_/_0.09)] lg:px-[15px]"
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
          onClick={() => setOpen((o) => !o)}
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
          <div className="animate-rise absolute top-[52px] right-0 z-60 w-[392px] overflow-hidden rounded-[20px] bg-white shadow-[0_24px_60px_-20px_rgb(26_26_25_/_0.3),0_1px_2px_rgb(26_26_25_/_0.08)]">
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

      <button
        type="button"
        title="Notifications"
        onClick={() => say('One unread: an action was blocked overnight.')}
        className="relative flex size-11 flex-none items-center justify-center rounded-[15px] border-0 bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)] hover:shadow-[0_4px_14px_-4px_rgb(26_26_25_/_0.16)]"
      >
        <span className="size-[14px] rounded-t-[6px] rounded-b-[3px] border-[1.8px] border-[#4A4A46]" />
        <span className="bg-orange-app absolute top-[9px] right-[10px] size-2 rounded-full border-2 border-white" />
      </button>
    </div>
  )
}
