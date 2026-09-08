'use client'

import Image from 'next/image'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Sidebar } from '@/components/shell/Sidebar'
import { useEscapeLayer } from '@/lib/escape'

/**
 * The navigation, in full-screen Fast mode.
 *
 * Full screen there is no room for a docked column without destroying the thing
 * full screen is for. So the nav floats: throw the mouse at the top-left corner
 * and it comes out over the page, and it leaves when you move away.
 *
 * The reveal is a window mousemove test, not an invisible element. An earlier
 * version used an 86 x 46%-of-height transparent button as the target, which
 * meant a large rectangle at the top-left silently ate every click underneath
 * it: the headline at narrow widths, the left column of shard cards at 1024,
 * and the top five rows of the History panel. A hover zone should cost nothing
 * to hit-testing, and a geometry check costs exactly nothing.
 */
const ZONE_X = 26
const ZONE_Y = 280
const CLOSE_DELAY = 260

export function HoverNav() {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overPanel = useRef(false)

  const cancelClose = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    cancelClose()
    // A grace period, so crossing the gap between corner and panel does not
    // slam it shut in your face.
    timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY)
  }, [cancelClose])

  useEffect(() => cancelClose, [cancelClose])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (e.clientX <= ZONE_X && e.clientY <= ZONE_Y) {
        cancelClose()
        setOpen(true)
      } else if (!overPanel.current) {
        scheduleClose()
      }
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => window.removeEventListener('mousemove', onMove)
  }, [cancelClose, scheduleClose])

  useEscapeLayer(open, () => setOpen(false))

  // focusout on the shared subtree, attached natively rather than as a JSX
  // handler: the wrapper is display:contents and has no business claiming a
  // role just to carry a listener.
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onFocusOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setOpen(false)
    }
    el.addEventListener('focusout', onFocusOut)
    return () => el.removeEventListener('focusout', onFocusOut)
  }, [])

  return (
    // display:contents keeps both children positioned against the overlay while
    // still giving them a common subtree for focusout, which is what lets a nav
    // opened by keyboard close again.
    <div ref={wrap} className="contents">
      <button
        type="button"
        aria-label="Show navigation"
        aria-expanded={open}
        onMouseEnter={cancelClose}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        className="absolute top-3 left-4 z-47 cursor-pointer border-0 bg-transparent p-0 md:top-4 md:left-6"
      >
        <Image
          src="/aiki-logo.png"
          alt="AiKi"
          width={120}
          height={120}
          priority
          className="h-[38px] w-auto transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:h-[50px]"
          style={{ transform: open ? 'scale(0.94)' : 'scale(1)' }}
        />
      </button>

      {/* Sits inside the reveal zone, so the hint points at somewhere that
          actually responds. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-[150px] left-0 z-46 h-[56px] w-[3px] rounded-r-full bg-[rgb(20_20_20_/_0.1)] transition-opacity duration-300"
        style={{ opacity: open ? 0 : 1 }}
      />

      {/* Flush to the edge rather than inset, so no sliver of the HISTORY tab
          survives underneath it to be clicked by accident. `inert` keeps the
          links out of the tab order while it is off screen. */}
      <nav
        aria-label="Main"
        inert={!open}
        onMouseEnter={() => {
          overPanel.current = true
          cancelClose()
        }}
        onMouseLeave={() => {
          overPanel.current = false
          scheduleClose()
        }}
        className="absolute top-2 bottom-2 left-0 z-48 w-[252px] transition-transform duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ transform: open ? 'translateX(0)' : 'translateX(-100%)' }}
      >
        <div className="bg-tray h-full overflow-hidden rounded-r-[20px] shadow-[0_30px_70px_-24px_rgb(20_20_20_/_0.45),0_0_0_1px_rgb(20_20_20_/_0.05)]">
          <Sidebar
            collapsed={false}
            onToggle={() => setOpen(false)}
            onNavigate={() => setOpen(false)}
          />
        </div>
      </nav>
    </div>
  )
}
