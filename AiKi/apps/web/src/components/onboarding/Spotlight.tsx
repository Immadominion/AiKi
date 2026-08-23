'use client'

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

/**
 * A coach mark: everything blurs except one thing, and a card points at it.
 *
 * Built from four panels around the target rather than from a mask, because a
 * mask cannot carry a backdrop filter and a hole punched with box-shadow cannot
 * blur what is behind it. Four blurred panels leave the target genuinely
 * untouched, which is the whole effect.
 *
 * Nothing here teaches by telling. Each beat points at something already on
 * screen, so the thing being explained is the thing you are looking at.
 */
export interface Beat {
  /** Matches `data-tour="…"` on the element to lift out of the blur. */
  target: string
  title: string
  body: string
  /** Replaces the default Next button when a beat asks for a decision. */
  actions?: (next: () => void) => React.ReactNode
  place?: 'below' | 'above' | 'right' | 'left'
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
  /** Taken from the target, so the ring never squares off a pill. */
  radius: string
}

const PAD = 10
const GAP = 16
const CARD = 320

export function Spotlight({ beats, onDone }: { beats: Beat[]; onDone: () => void }) {
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const beat = beats[i]

  const measure = useCallback(() => {
    if (!beat) return
    const el = document.querySelector(`[data-tour="${beat.target}"]`)
    if (!el) {
      setRect(null)
      return
    }
    const b = el.getBoundingClientRect()
    const r = getComputedStyle(el).borderRadius
    // A pill reports a radius larger than its own height; anything else gets its
    // real radius plus the padding the ring sits outside of.
    const px = Number.parseFloat(r)
    const radius = Number.isFinite(px) && px < b.height ? `${px + PAD}px` : r
    setRect({
      top: b.top - PAD,
      left: b.left - PAD,
      width: b.width + PAD * 2,
      height: b.height + PAD * 2,
      radius,
    })
  }, [beat])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    // The target can move: a font lands, the window resizes, the page scrolls.
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    const settle = setTimeout(measure, 260)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      clearTimeout(settle)
    }
  }, [measure])

  const next = useCallback(() => {
    if (i + 1 >= beats.length) onDone()
    else setI(i + 1)
  }, [i, beats.length, onDone])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone()
      if (e.key === 'Enter' || e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, onDone])

  if (!beat) return null

  // A beat whose target is missing has nothing to point at, so it is skipped
  // rather than shown floating in the middle of a blurred screen.
  if (!rect) {
    return (
      <div className="fixed inset-0 z-300 flex items-center justify-center">
        <button
          type="button"
          aria-label="Skip"
          onClick={onDone}
          className="absolute inset-0 cursor-default border-0 bg-[rgb(250_250_248_/_0.72)] backdrop-blur-[5px]"
        />
        <Card beat={beat} i={i} total={beats.length} next={next} skip={onDone} floating />
      </div>
    )
  }

  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight

  const place =
    beat.place ??
    (rect.top + rect.height + GAP + 190 < vh ? 'below' : rect.left > CARD + GAP ? 'left' : 'above')

  const pos: React.CSSProperties =
    place === 'below'
      ? {
          top: rect.top + rect.height + GAP,
          left: clamp(rect.left + rect.width / 2 - CARD / 2, vw),
        }
      : place === 'above'
        ? {
            top: Math.max(GAP, rect.top - GAP - 200),
            left: clamp(rect.left + rect.width / 2 - CARD / 2, vw),
          }
        : place === 'left'
          ? { top: clampY(rect.top, vh), left: Math.max(GAP, rect.left - GAP - CARD) }
          : {
              top: clampY(rect.top, vh),
              left: Math.min(vw - CARD - GAP, rect.left + rect.width + GAP),
            }

  const panel =
    'fixed bg-[rgb(250_250_248_/_0.72)] backdrop-blur-[5px] transition-[top,left,width,height] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]'

  return (
    <div className="fixed inset-0 z-300">
      {/* Four panels, leaving the target itself untouched and unblurred. */}
      <div className={panel} style={{ top: 0, left: 0, right: 0, height: Math.max(rect.top, 0) }} />
      <div
        className={panel}
        style={{ top: rect.top + rect.height, left: 0, right: 0, bottom: 0 }}
      />
      <div
        className={panel}
        style={{ top: rect.top, left: 0, width: Math.max(rect.left, 0), height: rect.height }}
      />
      <div
        className={panel}
        style={{
          top: rect.top,
          left: rect.left + rect.width,
          right: 0,
          height: rect.height,
        }}
      />

      {/* Clicking the blur moves on, so the tour never traps anyone. */}
      <button
        type="button"
        aria-label="Next"
        onClick={next}
        className="absolute inset-0 cursor-default border-0 bg-transparent"
      />

      <div
        aria-hidden
        className="pointer-events-none fixed ring-2 ring-[rgb(255_77_0_/_0.55)] transition-[top,left,width,height] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          borderRadius: rect.radius,
          boxShadow: '0 0 0 6px rgb(255 77 0 / 0.1), 0 24px 60px -24px rgb(255 77 0 / 0.5)',
        }}
      />

      <div className="fixed" style={pos}>
        <Card beat={beat} i={i} total={beats.length} next={next} skip={onDone} />
      </div>
    </div>
  )
}

const clamp = (x: number, vw: number) => Math.max(GAP, Math.min(x, vw - CARD - GAP))
const clampY = (y: number, vh: number) => Math.max(GAP, Math.min(y, vh - 200 - GAP))

function Card({
  beat,
  i,
  total,
  next,
  skip,
  floating,
}: {
  beat: Beat
  i: number
  total: number
  next: () => void
  skip: () => void
  floating?: boolean
}) {
  return (
    <div
      className={`animate-rise w-[320px] rounded-[20px] bg-white p-[18px] shadow-[0_30px_70px_-24px_rgb(20_20_20_/_0.45)] ${
        floating ? 'relative' : ''
      }`}
    >
      <div className="text-[15px] font-extrabold tracking-[-0.015em]">{beat.title}</div>
      <p className="mt-[6px] mb-0 text-[13px] leading-[1.55] text-pretty text-[#5C5C5C]">
        {beat.body}
      </p>

      {/* Where you are is the least important thing on this card, so it reads
          last and quietest: below the words, left of the actions, at the size
          of a punctuation mark. */}
      <div className="mt-[18px] flex items-center gap-[10px]">
        {/* A bare span with an aria-label announces nothing. Progress is what
            this is, so that is the role it takes. */}
        <span
          role="progressbar"
          aria-label="Walkthrough progress"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={i + 1}
          aria-valuetext={`Step ${i + 1} of ${total}`}
          className="flex flex-none items-center gap-[5px]"
        >
          {Array.from({ length: total }, (_, n) => `dot-${n}`).map((id, n) => (
            <span
              key={id}
              className="block rounded-full transition-all duration-300"
              style={
                n === i
                  ? { width: 14, height: 5, background: 'var(--color-orange)' }
                  : {
                      width: 5,
                      height: 5,
                      background: n < i ? 'rgb(255 77 0 / 0.32)' : 'rgb(20 20 20 / 0.12)',
                    }
              }
            />
          ))}
        </span>
        <div className="flex-1" />
        {beat.actions ? (
          beat.actions(next)
        ) : (
          <>
            <button
              type="button"
              onClick={skip}
              className="h-[38px] rounded-[12px] border-0 bg-none px-[10px] text-[13px] font-semibold text-[#8A8A8A] hover:text-[#141414]"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={next}
              className="h-[38px] rounded-[12px] border-0 bg-[linear-gradient(135deg,#FF4D00,#FF7A2E)] px-[18px] text-[13px] font-bold text-white shadow-[0_10px_22px_-12px_rgb(255_77_0_/_0.8)]"
            >
              {i + 1 === total ? 'Done' : 'Next'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
