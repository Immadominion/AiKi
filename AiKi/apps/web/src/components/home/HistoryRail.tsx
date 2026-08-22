'use client'

import { useEffect, useState } from 'react'

interface Ask {
  id: string
  text: string
  outcome: string
  tone: 'good' | 'work' | 'idle' | 'warn'
  when: string
  agent?: { initial: string; bg: string }
}

interface Group {
  label: string
  asks: Ask[]
}

/**
 * Everything you have ever asked, and what came of it.
 *
 * Not a transcript of chat turns — an ask is a unit of work, so each row carries
 * the outcome next to the words. That is the difference between a history you
 * scroll and a history you can act on: every row here is resumable.
 */
const HISTORY: Group[] = [
  {
    label: 'Today',
    asks: [
      {
        id: 'a1',
        text: 'Protect me from liquidation on Venus',
        outcome: 'Guardian repaid 72 USDT · health 1.22 → 1.47',
        tone: 'good',
        when: '02:39',
        agent: { initial: 'G', bg: 'linear-gradient(135deg,#FF4D00,#FF8A3D)' },
      },
      {
        id: 'a2',
        text: 'Keep my BNB / USDT position in range',
        outcome: 'Gridly is rebalancing now',
        tone: 'work',
        when: '05:12',
        agent: { initial: 'G', bg: 'linear-gradient(135deg,#7C5CFF,#C05CFF)' },
      },
      {
        id: 'a3',
        text: 'Find better yield for 2 BNB',
        outcome: 'YieldMax found 11.8% APY · waiting on you',
        tone: 'warn',
        when: '09:03',
        agent: { initial: 'Y', bg: 'linear-gradient(135deg,#3B82F6,#8B5CF6)' },
      },
    ],
  },
  {
    label: 'Yesterday',
    asks: [
      {
        id: 'b1',
        text: 'Is my Venus position safe overnight?',
        outcome: 'Checked 14 times · no action needed',
        tone: 'idle',
        when: '23:10',
        agent: { initial: 'G', bg: 'linear-gradient(135deg,#FF4D00,#FF8A3D)' },
      },
      {
        id: 'b2',
        text: 'Move my idle USDT somewhere better',
        outcome: 'Blocked · over your $80 per-action limit',
        tone: 'warn',
        when: '18:44',
        agent: { initial: 'H', bg: 'linear-gradient(135deg,#0EA5E9,#3B82F6)' },
      },
    ],
  },
  {
    label: 'Earlier',
    asks: [
      {
        id: 'c1',
        text: 'Run a grid strategy on BNB',
        outcome: 'Gridly placed 4 orders · $580 to $640',
        tone: 'good',
        when: 'Tue',
        agent: { initial: 'G', bg: 'linear-gradient(135deg,#7C5CFF,#C05CFF)' },
      },
      {
        id: 'c2',
        text: 'Who can watch a Pancake v3 position?',
        outcome: 'No agent claimed it · logged as unmet',
        tone: 'idle',
        when: 'Mon',
      },
    ],
  },
]

const DOT: Record<Ask['tone'], string> = {
  good: '#00A092',
  work: '#FF4D00',
  idle: '#C9C9C9',
  warn: '#FFD400',
}

export function HistoryRail({ onResume }: { onResume: (ask: string) => void }) {
  const [open, setOpen] = useState(false)

  // ⌘/ opens it from anywhere, because reaching for history should never mean
  // hunting for a control on a page whose whole point is a single input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      {/* Collapsed: a thin rail that does not compete with the field. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Your asks (⌘/)"
        className={`absolute top-1/2 left-4 z-40 flex h-[132px] w-[34px] -translate-y-1/2 flex-col items-center justify-center gap-[7px] rounded-[14px] border border-[rgb(20_20_20_/_0.06)] bg-white/70 backdrop-blur transition-all hover:bg-white ${
          open ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
      >
        <span className="flex flex-col gap-[3px]" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="block h-[2px] w-[13px] rounded-full bg-[#B4B4B0]" />
          ))}
        </span>
        <span
          className="text-[10.5px] font-bold tracking-[0.08em] text-[#8A8A8A]"
          style={{ writingMode: 'vertical-rl' }}
        >
          YOUR ASKS
        </span>
      </button>

      {open && (
        <div className="animate-rise absolute top-4 bottom-4 left-4 z-46 flex w-[316px] flex-col overflow-hidden rounded-[26px] border border-[rgb(20_20_20_/_0.07)] bg-white shadow-[0_34px_84px_-32px_rgb(20_20_20_/_0.4)]">
          <div className="flex flex-none items-center justify-between px-[18px] pt-[17px] pb-3">
            <span className="text-[14.5px] font-bold">Your asks</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex size-[26px] items-center justify-center rounded-full border-0 bg-[#F3F3F1] text-[11px] text-[#6B6B6B] hover:bg-[#EAEAE7]"
            >
              ×
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-[10px] pb-3">
            {HISTORY.map((g) => (
              <div key={g.label} className="mb-[14px]">
                <div className="px-2 pb-[6px] text-[11.5px] font-semibold text-[#9C9C98]">
                  {g.label}
                </div>
                <div className="flex flex-col gap-[2px]">
                  {g.asks.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onResume(a.text)}
                      className="flex w-full items-start gap-[10px] rounded-[14px] border-0 bg-none px-2 py-[10px] text-left transition-colors hover:bg-[#F8F8F6]"
                    >
                      {a.agent ? (
                        <span
                          className="mt-[2px] flex size-[26px] flex-none items-center justify-center rounded-full text-[11px] font-extrabold text-white"
                          style={{ background: a.agent.bg }}
                        >
                          {a.agent.initial}
                        </span>
                      ) : (
                        <span className="mt-[2px] flex size-[26px] flex-none items-center justify-center rounded-full bg-[#F3F3F1] text-[11px] font-extrabold text-[#B4B4B0]">
                          ?
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] leading-[1.35] font-semibold text-pretty">
                          {a.text}
                        </span>
                        <span className="mt-[5px] flex items-start gap-[6px]">
                          <span
                            className="mt-[5px] size-[5px] flex-none rounded-full"
                            style={{ background: DOT[a.tone] }}
                          />
                          <span className="text-[11.5px] leading-[1.35] text-pretty text-[#8A8A8A]">
                            {a.outcome}
                          </span>
                        </span>
                      </span>
                      <span className="mt-[3px] flex-none text-[11px] font-medium text-[#B4B4B0] tabular-nums">
                        {a.when}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex-none border-t border-[rgb(20_20_20_/_0.06)] px-[18px] py-[13px] text-[11.5px] leading-[1.45] text-[#767676]">
            Every ask is kept, including the ones no agent could take. Those are how we know what to
            build next.
          </div>
        </div>
      )}
    </>
  )
}
