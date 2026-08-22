'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { rankTask, TASKS, type Task } from '@/lib/tasks'

const HINTS: readonly [string, ...string[]] = [
  'Protect me from liquidation on Venus',
  'Keep my BNB / USDT position in range',
  'Find better yield for 2 BNB',
  'Run a grid strategy on BNB',
]

export function AskField({
  onSubmit,
  onPick,
}: {
  onSubmit: (q: string) => void
  onPick: (task: Task) => void
}) {
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const [hintI, setHintI] = useState(0)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const id = setInterval(() => setHintI((i) => i + 1), 3800)
    return () => {
      clearInterval(id)
      clearTimeout(blurTimer.current)
    }
  }, [])

  const hint = HINTS[hintI % HINTS.length] ?? HINTS[0]

  const hits = useMemo(() => {
    return TASKS.map((t) => ({ t, s: rankTask(t, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t)
  }, [q])

  const panelOpen = focused && q.trim().length > 1

  return (
    <div className="relative mt-7 w-full">
      <div
        className="flex h-[62px] items-center gap-3 rounded-full border bg-white pr-[8px] pl-[20px] transition-[border-color,box-shadow] duration-200 md:h-[72px] md:pr-[10px] md:pl-[26px]"
        style={{
          borderColor: focused ? 'rgb(20 20 20 / 0.16)' : 'rgb(20 20 20 / 0.08)',
          boxShadow: focused
            ? '0 30px 72px -26px rgb(20 20 20 / 0.32)'
            : '0 24px 60px -30px rgb(20 20 20 / 0.26)',
        }}
      >
        <span className="relative flex h-full min-w-0 flex-1 items-center">
          <input
            value={q}
            aria-label="What do you need done?"
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              blurTimer.current = setTimeout(() => setFocused(false), 150)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && !q) {
                e.preventDefault()
                setQ(hint)
              }
              if (e.key === 'Enter') onSubmit(q.trim())
            }}
            className="relative z-2 h-full w-full border-0 bg-none text-[16px] font-medium text-[#141414] outline-none md:text-[18px]"
          />
          {!q && (
            <span className="pointer-events-none absolute inset-x-0 z-1 flex items-center gap-[10px]">
              <span className="animate-hint overflow-hidden text-[16px] font-medium text-ellipsis whitespace-nowrap text-[#9A9A9A] md:text-[18px]">
                {hint}
              </span>
              <span className="hidden flex-none rounded-[7px] bg-[#F4F4F2] px-[7px] py-1 text-[10.5px] font-bold tracking-[0.03em] text-[#8A8A8A] md:inline">
                TAB
              </span>
            </span>
          )}
        </span>
        <button
          type="button"
          title="Find agents"
          onClick={() => onSubmit(q.trim())}
          className="flex size-[46px] flex-none items-center justify-center rounded-full border-0 bg-[linear-gradient(135deg,#FF4D00,#FF7A2E)] text-[19px] text-white shadow-[0_14px_28px_-12px_rgb(255_77_0_/_0.7)] transition-transform duration-150 hover:scale-105 active:scale-[0.97] md:size-[54px]"
        >
          →
        </button>
      </div>

      {panelOpen && (
        <div className="animate-rise absolute top-[88px] right-[10px] left-[10px] z-35 overflow-hidden rounded-[22px] border border-[rgb(20_20_20_/_0.06)] bg-white shadow-[0_34px_84px_-30px_rgb(20_20_20_/_0.4)]">
          {hits.length > 0 ? (
            hits.map((hit) => (
              <button
                key={hit.title}
                type="button"
                onClick={() => {
                  setQ(hit.intent)
                  onPick(hit)
                }}
                className="flex w-full items-center gap-[13px] border-0 bg-none px-[18px] py-[13px] text-left hover:bg-[#F8F8F6]"
              >
                <span
                  className="flex size-[34px] flex-none items-center justify-center rounded-full text-[13px] font-extrabold text-white"
                  style={{ background: hit.bg }}
                >
                  {hit.glyph}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-bold">{hit.title}</span>
                  <span className="mt-px block text-[12px] text-[#8A8A8A]">{hit.sub}</span>
                </span>
                <span className="flex-none text-[11.5px] font-semibold text-[#8A8A8A]">
                  {hit.meta}
                </span>
              </button>
            ))
          ) : (
            <div className="flex items-start gap-[11px] px-[18px] py-4">
              <span className="mt-px flex size-5 flex-none items-center justify-center rounded-[7px] bg-[#FFD400] text-[11px] font-extrabold">
                ?
              </span>
              <span className="text-[13px] leading-[1.55] text-[#5C5C5C]">
                AiKi claims four kinds of work today. We&rsquo;d rather tell you that than show
                agents that can&rsquo;t do this, and we log every unmet ask.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
