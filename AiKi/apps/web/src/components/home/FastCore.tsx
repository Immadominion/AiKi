'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { agentHref, route } from '@/lib/routes'
import type { Task } from '@/lib/tasks'
import { AskField } from './AskField'
import { HistoryRail } from './HistoryRail'
import { ShardField } from './ShardField'
import { type Frame, SHARDS_DISCOVER, SHARDS_RETURNING } from './shards'

/**
 * Fast mode's actual content, independent of the box it sits in.
 *
 * There are three places this renders: the full-screen home, the panel inside
 * the app shell, and the full-screen overlay you can toggle into from that
 * panel. They are the same composition measured against different boxes, so the
 * measurements live on the frame and the markup lives here exactly once.
 */
export function FastCore({
  frame,
  connected,
  userName = 'Dominion',
  footer,
  landmark = false,
}: {
  frame: Frame
  connected: boolean
  userName?: string
  /** What sits under the field. Differs by variant, so the caller supplies it. */
  footer?: React.ReactNode
  /**
   * Whether this instance owns the page's main landmark.
   *
   * Only the standalone home does. Inside the app shell there is already a
   * <main id="main"> wrapping the route, and a second one would be both a
   * duplicate id and a nested landmark.
   */
  landmark?: boolean
}) {
  const [resumed, setResumed] = useState(0)
  const say = useToast()
  const router = useRouter()

  const first = !connected
  const shards = first ? SHARDS_DISCOVER : SHARDS_RETURNING

  const submit = (q: string) => {
    if (!q) {
      say('Say what you need, or press Tab for the suggestion.')
      return
    }
    // Recorded so History shows itself only to someone who has actually asked
    // something, rather than greeting a first-time visitor with five asks they
    // never made.
    try {
      localStorage.setItem('aiki.asked.v1', 'yes')
    } catch {
      /* a private window can refuse; the rail simply stays empty */
    }
    router.push(route(`/explore?q=${encodeURIComponent(q)}`))
  }

  return (
    <>
      {/* The two vignettes sandwich the shards, so the cards dissolve as they
          approach the question instead of crowding it. */}
      <div
        className={`pointer-events-none absolute top-[46%] left-1/2 z-3 -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgb(250_250_248_/_0.96)_0%,rgb(250_250_248_/_0.8)_45%,rgb(250_250_248_/_0.4)_70%,rgb(250_250_248_/_0)_90%)] ${frame.vignetteInner}`}
      />

      <ShardField
        shards={shards}
        frame={frame}
        hideBelow={frame.hideBelow}
        onPick={(name) => router.push(agentHref(name.toLowerCase()))}
      />

      <div
        className={`pointer-events-none absolute top-[46%] left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgb(250_250_248_/_0.97)_0%,rgb(250_250_248_/_0.9)_38%,rgb(250_250_248_/_0.55)_62%,rgb(250_250_248_/_0)_86%)] ${frame.vignetteOuter}`}
      />

      <HistoryRail
        onResume={(ask) => {
          setResumed((n) => n + 1)
          say(`Reopening “${ask}”.`)
        }}
      />

      <Hero landmark={landmark} className={frame.heroClass}>
        <div
          className={`leading-[1.4] font-semibold whitespace-nowrap text-[#8A8A8A] ${frame.greetClass}`}
        >
          {first ? 'Welcome to AiKi' : `Good morning, ${userName}`}
        </div>
        <h1
          className={`mt-[9px] max-w-full text-center leading-[1.02] font-extrabold tracking-[-0.036em] text-balance ${frame.titleClass}`}
        >
          What do you need done?
        </h1>

        <AskField
          key={resumed}
          onSubmit={submit}
          onPick={(t: Task) => say(`Finding agents for “${t.intent}”.`)}
        />

        {footer}
      </Hero>
    </>
  )
}

function Hero({
  landmark,
  className,
  children,
}: {
  landmark: boolean
  className: string
  children: React.ReactNode
}) {
  const shared = `absolute top-[46%] left-1/2 z-30 flex -translate-x-1/2 -translate-y-[52%] flex-col items-center ${className}`
  return landmark ? (
    <main id="main" className={shared}>
      {children}
    </main>
  ) : (
    <div className={shared}>{children}</div>
  )
}

/**
 * The warm light and the grid.
 *
 * Full screen these are the whole atmosphere. Inside a panel they are noise:
 * the tray behind the panel already carries a grid, and a glow bleeding off the
 * corner of a card reads as a rendering artefact rather than as light.
 */
export function FastDecor() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 z-1"
        style={{
          backgroundImage:
            'linear-gradient(rgb(120 118 112 / 0.13) 1px,transparent 1px),linear-gradient(90deg,rgb(120 118 112 / 0.13) 1px,transparent 1px)',
          backgroundSize: 'var(--aiki-grid) var(--aiki-grid)',
          backgroundPosition: 'center center',
        }}
      />
      <div className="pointer-events-none absolute -right-[100px] -bottom-[120px] z-2 h-[320px] w-[340px] rounded-[48%_52%_44%_56%] bg-[radial-gradient(ellipse_at_40%_40%,rgb(255_77_0_/_0.5),rgb(255_90_20_/_0.34)_45%,rgb(255_120_40_/_0)_72%)] blur-[28px] md:-right-[160px] md:-bottom-[190px] md:h-[560px] md:w-[620px]" />
      <div className="pointer-events-none absolute -top-[70px] -left-[60px] z-2 h-[190px] w-[210px] bg-[radial-gradient(ellipse_at_60%_60%,rgb(255_77_0_/_0.3),rgb(255_150_60_/_0)_70%)] blur-[26px] md:-top-[110px] md:-left-[90px] md:h-[300px] md:w-[340px]" />
    </>
  )
}
