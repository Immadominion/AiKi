'use client'

import Link from 'next/link'
import { useState } from 'react'

interface LiveAgent {
  initial: string
  name: string
  detail: React.ReactNode
  bg: string
}

const LIVE: LiveAgent[] = [
  {
    initial: 'G',
    name: 'Guardian',
    detail: 'Health 1.82 · $14.20 of $250',
    bg: 'linear-gradient(135deg,#FF4D00,#FF8A3D)',
  },
  {
    initial: 'G',
    name: 'Gridly',
    detail: (
      <span className="flex items-center gap-[6px] text-[#C93E00]">
        <span className="size-[5px] rounded-full bg-[#FF4D00] [animation:aikiBreathe_1.1s_ease-in-out_infinite]" />
        Rebalancing · $31.80 of $120
      </span>
    ),
    bg: 'linear-gradient(135deg,#7C5CFF,#C05CFF)',
  },
]

/**
 * Top-right cluster: navigation, the always-visible status pill, and the panel
 * behind it.
 *
 * The pill is the one thing on this page that must never lie — it is the answer
 * to "is anything happening with my money right now", so it is present in every
 * state including the one where the answer is "no agents yet".
 */
export function StatusCluster({ first, onSay }: { first: boolean; onSay: (msg: string) => void }) {
  const [open, setOpen] = useState(false)
  const shown = open && !first

  return (
    <div className="absolute top-3 right-3 z-45 flex flex-col items-end gap-[10px] md:top-6 md:right-6">
      <div className="flex items-center gap-1">
        <div className="hidden items-center gap-1 lg:flex">
          <Link
            href="/explore"
            className="flex h-9 items-center rounded-[12px] px-[13px] text-[13px] font-semibold text-[#767676] transition-colors hover:bg-[rgb(20_20_20_/_0.05)] hover:text-[#141414]"
          >
            Explore
          </Link>
          <Link
            href="/agents"
            className="flex h-9 items-center rounded-[12px] px-[13px] text-[13px] font-semibold text-[#767676] transition-colors hover:bg-[rgb(20_20_20_/_0.05)] hover:text-[#141414]"
          >
            My agents
          </Link>
          <Link
            href="/activity"
            className="flex h-9 items-center rounded-[12px] px-[13px] text-[13px] font-semibold text-[#767676] transition-colors hover:bg-[rgb(20_20_20_/_0.05)] hover:text-[#141414]"
          >
            Activity
          </Link>
        </div>

        <button
          type="button"
          onClick={() => {
            if (first) {
              onSay('Hire your first agent and it reports here: status, spend, and a stop button.')
              return
            }
            setOpen((o) => !o)
          }}
          className="ml-[6px] flex h-10 items-center gap-[9px] rounded-full border border-[rgb(20_20_20_/_0.07)] bg-white pr-2 pl-[14px] text-[13px] font-semibold whitespace-nowrap shadow-[0_12px_30px_-18px_rgb(20_20_20_/_0.3)] hover:shadow-[0_16px_36px_-18px_rgb(20_20_20_/_0.38)]"
        >
          <span
            className="animate-breathe size-[7px] rounded-full"
            style={{ background: first ? '#C9C9C9' : '#00A092' }}
          />
          <span className="whitespace-nowrap">
            {first ? 'No agents yet' : '2 agents'}
            <span className="hidden sm:inline">{first ? '' : ' · all good'}</span>
          </span>
          <span className="flex size-[26px] items-center justify-center rounded-full bg-[#F3F3F1] text-[11px] text-[#6B6B6B]">
            {shown ? '×' : '⌄'}
          </span>
        </button>

        <button
          type="button"
          title="Wallet & account"
          onClick={() => onSay('Wallet & account settings come later in the journey.')}
          className="flex size-10 flex-none items-center justify-center rounded-full border-0 bg-[linear-gradient(135deg,#FF4D00,#FFB300)] text-[14px] font-extrabold text-white shadow-[0_12px_28px_-14px_rgb(255_77_0_/_0.7)]"
        >
          D
        </button>
      </div>

      {shown && (
        <div className="animate-rise w-[min(368px,calc(100vw-24px))] overflow-hidden rounded-[26px] border border-[rgb(20_20_20_/_0.07)] bg-white shadow-[0_34px_84px_-32px_rgb(20_20_20_/_0.4)]">
          {LIVE.map((a, i) => (
            <div key={a.name}>
              {i > 0 && <div className="mx-4 h-px bg-[rgb(20_20_20_/_0.06)]" />}
              <div className="flex items-center gap-3 px-4 py-[15px]">
                <span
                  className="flex size-[38px] flex-none items-center justify-center rounded-full text-[15px] font-extrabold text-white"
                  style={{ background: a.bg }}
                >
                  {a.initial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold">{a.name}</span>
                  <span className="mt-px block text-[12px] text-[#767676]">{a.detail}</span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onSay(`Pause is instant and free. ${a.name} stops within seconds.`)
                  }
                  className="h-8 flex-none rounded-full border-0 bg-[#F3F3F1] px-[13px] text-[12px] font-semibold hover:bg-[#EAEAE7]"
                >
                  Pause
                </button>
              </div>
            </div>
          ))}

          <div className="mx-4 mt-1 mb-[14px] flex items-start gap-[10px] rounded-2xl bg-[#FFF8E0] px-[13px] py-[11px]">
            <span className="mt-px flex size-[18px] flex-none items-center justify-center rounded-md bg-[#FFD400] text-[10px] font-extrabold">
              !
            </span>
            <span className="text-[12px] leading-[1.5] text-[#4F4A38]">
              Overnight, Guardian tried to spend <b>$91.20</b>, over your $80 limit. AiKi stopped
              it. Nothing was spent.
            </span>
          </div>

          <div className="flex border-t border-[rgb(20_20_20_/_0.06)]">
            <Link
              href="/activity"
              className="flex-1 p-[13px] text-center text-[13px] font-bold hover:bg-[#FAFAF8]"
            >
              Everything they did →
            </Link>
            <Link
              href="/market"
              className="flex-none border-l border-[rgb(20_20_20_/_0.06)] px-4 py-[13px] text-[13px] font-semibold text-[#767676] hover:bg-[#FAFAF8] hover:text-[#141414]"
            >
              Market view
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
