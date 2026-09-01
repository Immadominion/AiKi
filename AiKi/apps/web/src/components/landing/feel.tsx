'use client'

import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './landing.module.css'

/**
 * The feel layer: the small physics that make a page tactile.
 *
 * Reverse-engineered as technique from the reference the founder pointed at —
 * its compiled bundle fingerprints to scrubbed scroll choreography, per-frame
 * lerps, press-and-hold interactions and a custom cursor — and rebuilt here
 * from scratch in AiKi's own register. Every effect respects
 * prefers-reduced-motion, and everything degrades to plain clicks and native
 * scroll on touch devices.
 */

/**
 * The page is a deck, and this owns the gesture.
 *
 * Lenis's snap was free-scrolling first and animating back afterwards, which
 * is why a chapter would slide most of the way out of frame and then jump
 * home, and why a hard flick could travel two chapters before the snap caught
 * it. Both are unavoidable when snapping is a correction applied after the
 * fact.
 *
 * So nothing free-scrolls. Wheel, touch and keys are intercepted, and each
 * committed gesture advances exactly one chapter, animated by us. It cannot
 * overshoot, cannot skip, and cannot snap back, because the page is never in
 * a wrong place to be corrected from.
 *
 * Native scroll position is still what moves, rather than a transform, so
 * everything scrubbed off scrollY (the camera, the ruler needle) keeps working
 * untouched.
 */

const PAGE_MS = 760
const WHEEL_COMMIT = 18
const SWIPE_COMMIT = 42
/** Quiet window after landing, for touch and keys. */
const SETTLE_MS = 140
/**
 * Firefox on Windows and Linux reports wheel deltas in LINES, not pixels: one
 * notch is deltaY 3, which never clears a pixel threshold. Without this the
 * page is completely frozen to the mouse wheel there, because the native
 * scroll has already been cancelled.
 */
const LINE_PX = 40
/**
 * A wheel stream quieter than this is a new gesture rather than the tail of
 * one. macOS momentum keeps firing for a second or more after the fingers
 * lift, well past any fixed settle window, so a gesture ends when the stream
 * stops rather than on a clock.
 */
const GESTURE_GAP_MS = 90

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

export function usePagedScroll(enabled: boolean, sectionSelector: string) {
  /*
   * Handed back so every other control on the page moves through this same
   * function. Anything that scrolls independently (a scrollIntoView on a
   * ruler tick, say) leaves the pager's idea of where it is behind, and the
   * next gesture then travels from a stale index and appears to skip pages.
   */
  const goToRef = useRef<(index: number) => void>(() => {})

  useEffect(() => {
    if (!enabled) return

    let targets: number[] = []
    let animating = false
    let settledAt = 0
    let raf = 0
    let resizeRaf = 0
    /** The chapter the last committed gesture aimed at, for re-anchoring. */
    let anchorIndex = 0
    let lastWheelAt = 0
    let armed = true

    // The landing always opens at its first chapter; a restored scroll offset
    // would drop somebody into the middle of a story they have not read.
    const previousRestoration = history.scrollRestoration
    history.scrollRestoration = 'manual'

    const measure = () => {
      targets = [...document.querySelectorAll<HTMLElement>(sectionSelector)].map(
        (section) => section.getBoundingClientRect().top + window.scrollY,
      )
    }

    /*
     * Derived from where the page ACTUALLY is, never from a stored value. That
     * makes the pager immune to anything else moving the scroll.
     */
    const currentIndex = () => {
      const y = window.scrollY
      return targets.reduce(
        (best, target, i) => (Math.abs(target - y) < Math.abs((targets[best] ?? 0) - y) ? i : best),
        0,
      )
    }

    const goTo = (next: number) => {
      const clamped = Math.max(0, Math.min(targets.length - 1, next))
      const to = targets[clamped]
      if (to === undefined || animating) return
      anchorIndex = clamped
      const from = window.scrollY
      if (Math.abs(to - from) < 1) return

      animating = true
      const started = performance.now()
      const step = () => {
        const progress = Math.min(1, (performance.now() - started) / PAGE_MS)
        window.scrollTo(0, from + (to - from) * easeInOutCubic(progress))
        if (progress < 1) {
          raf = requestAnimationFrame(step)
          return
        }
        animating = false
        settledAt = performance.now()
      }
      raf = requestAnimationFrame(step)
    }

    const busy = () => animating || performance.now() - settledAt < SETTLE_MS

    const onWheel = (event: WheelEvent) => {
      /*
       * Zoom arrives here as a wheel event with a modifier held, and a
       * trackpad pinch is synthesised as ctrl+wheel. Swallowing those would
       * kill page zoom outright, which the small mono labels on this page make
       * somebody genuinely need.
       */
      if (event.ctrlKey || event.metaKey) return
      // Otherwise always prevented: the page moves only through goTo.
      event.preventDefault()

      // In pixels, whatever unit the browser chose to report.
      const pixels =
        event.deltaMode === 1
          ? event.deltaY * LINE_PX
          : event.deltaMode === 2
            ? event.deltaY * window.innerHeight
            : event.deltaY

      const now = performance.now()
      // A gap in the stream re-arms the gesture; momentum never re-arms it.
      if (now - lastWheelAt > GESTURE_GAP_MS) armed = true
      lastWheelAt = now

      if (animating || !armed || Math.abs(pixels) < WHEEL_COMMIT) return
      armed = false
      goTo(currentIndex() + (pixels > 0 ? 1 : -1))
    }

    let touchStart = 0
    const onTouchStart = (event: TouchEvent) => {
      touchStart = event.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent) => {
      // Two fingers is a pinch-zoom, not a page turn.
      if (event.touches.length > 1) return
      event.preventDefault()
      if (busy()) return
      const y = event.touches[0]?.clientY ?? 0
      const travelled = touchStart - y
      if (Math.abs(travelled) < SWIPE_COMMIT) return
      touchStart = y
      goTo(currentIndex() + (travelled > 0 ? 1 : -1))
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const keys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Home', 'End']
      if (!keys.includes(event.key)) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable]')) return
      /*
       * Space is a control's activation key before it is a paging key. A button
       * fires its click on keyup only if the keydown was not prevented, so
       * swallowing Space here silently cancels the click on every focused
       * button. Links are deliberately not exempt: Space does not activate an
       * anchor, it scrolls.
       */
      if (event.key === ' ' && target?.closest('button, [role="button"], summary')) return
      event.preventDefault()
      if (busy()) return
      if (event.key === 'Home') return goTo(0)
      if (event.key === 'End') return goTo(targets.length - 1)
      goTo(currentIndex() + (event.key === 'ArrowUp' || event.key === 'PageUp' ? -1 : 1))
    }

    /*
     * Re-measure AND re-anchor. The section offsets change with the viewport,
     * so measuring alone leaves the page parked between two chapters. The index
     * is captured against the OLD targets before they are replaced, or the
     * re-snap cements an off-by-one instead of undoing it.
     */
    const onResize = () => {
      cancelAnimationFrame(resizeRaf)
      const index = animating ? anchorIndex : currentIndex()
      resizeRaf = requestAnimationFrame(() => {
        measure()
        const to = targets[Math.max(0, Math.min(targets.length - 1, index))]
        if (to !== undefined) {
          cancelAnimationFrame(raf)
          animating = false
          window.scrollTo(0, to)
          anchorIndex = index
        }
      })
    }

    measure()
    goToRef.current = goTo
    window.addEventListener('resize', onResize)
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('keydown', onKeyDown)

    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(resizeRaf)
      history.scrollRestoration = previousRestoration
      goToRef.current = () => {}
      window.removeEventListener('resize', onResize)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [enabled, sectionSelector])

  return useCallback((index: number) => goToRef.current(index), [])
}

/** Elements that lean toward the hand. Capped at a few pixels — furniture
 *  shifting its weight, not furniture chasing you. */
export function useMagnetic<T extends HTMLElement>(strength = 0.22, limit = 6) {
  const ref = useRef<T>(null)

  const onPointerMove = useCallback(
    (event: React.PointerEvent<T>) => {
      const node = ref.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const dx = event.clientX - (rect.left + rect.width / 2)
      const dy = event.clientY - (rect.top + rect.height / 2)
      const x = Math.max(-limit, Math.min(limit, dx * strength))
      const y = Math.max(-limit, Math.min(limit, dy * strength))
      node.style.setProperty('--magnet-x', `${x.toFixed(1)}px`)
      node.style.setProperty('--magnet-y', `${y.toFixed(1)}px`)
    },
    [strength, limit],
  )

  const onPointerLeave = useCallback(() => {
    const node = ref.current
    if (!node) return
    node.style.setProperty('--magnet-x', '0px')
    node.style.setProperty('--magnet-y', '0px')
  }, [])

  return { ref, onPointerMove, onPointerLeave }
}

const HOLD_MS = 450

/**
 * Press and hold: a ring fills while you commit, and letting go early undoes
 * it. A tap teaches the gesture by nudging instead of failing silently.
 * Keyboard activation stays immediate — the ritual is for pointers.
 */
export function useHoldAction(onComplete: () => void, reducedMotion: boolean) {
  const [progress, setProgress] = useState(0)
  const [teasing, setTeasing] = useState(false)
  const raf = useRef(0)
  const start = useRef(0)
  const held = useRef(false)

  const cancel = useCallback((teach: boolean) => {
    cancelAnimationFrame(raf.current)
    if (teach && !held.current) {
      setTeasing(true)
      window.setTimeout(() => setTeasing(false), 500)
    }
    held.current = false
    setProgress(0)
  }, [])

  const onPointerDown = useCallback(() => {
    if (reducedMotion) return
    held.current = false
    start.current = performance.now()
    const tick = () => {
      const value = Math.min(1, (performance.now() - start.current) / HOLD_MS)
      setProgress(value)
      if (value >= 1) {
        held.current = true
        setProgress(0)
        onComplete()
        return
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [onComplete, reducedMotion])

  const onPointerUp = useCallback(() => {
    if (reducedMotion) return
    cancel(true)
  }, [cancel, reducedMotion])

  const onPointerLeave = useCallback(() => {
    if (reducedMotion) return
    cancel(false)
  }, [cancel, reducedMotion])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onComplete()
      }
    },
    [onComplete],
  )

  return { progress, teasing, onPointerDown, onPointerUp, onPointerLeave, onKeyDown }
}

/** The headline arrives a word at a time, rising out of its own baseline. */
export function SplitWords({
  words,
  accent,
  reducedMotion,
  delay = 0,
}: {
  words: string[]
  /** Rendered after the last word, in orange. */
  accent?: string
  reducedMotion: boolean
  delay?: number
}) {
  return (
    <>
      {words.map((word, index) => (
        <span key={word} className={styles.splitMask}>
          <motion.span
            className={styles.splitWord}
            initial={reducedMotion ? false : { y: '130%' }}
            animate={{ y: '0%' }}
            transition={{
              duration: 0.74,
              ease: [0.22, 1, 0.36, 1],
              delay: delay + index * 0.075,
            }}
          >
            {word}
            {accent && index === words.length - 1 ? <span>{accent}</span> : null}
          </motion.span>
        </span>
      ))}
    </>
  )
}
