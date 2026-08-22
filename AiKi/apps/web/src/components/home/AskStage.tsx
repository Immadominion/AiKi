'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { agentHref, route } from '@/lib/routes'
import type { Task } from '@/lib/tasks'
import { AskField } from './AskField'
import { HistoryRail } from './HistoryRail'
import { ShardField } from './ShardField'
import { StatusCluster } from './StatusCluster'
import { SHARDS_FIRST, SHARDS_RETURNING } from './shards'

/**
 * The one-ask home.
 *
 * Layer order matters and is the reason everything here is absolutely positioned:
 * grid (1) → glows (2) → inner vignette (3) → shards (6) → outer vignette (20) →
 * hero (30) → chrome (40+). The two vignettes sandwich the shards so the cards
 * dissolve as they approach the question instead of crowding it.
 */
export function AskStage({ userName = 'Dominion' }: { userName?: string }) {
  const [view, setView] = useState<'returning' | 'first'>('returning')
  const [resumed, setResumed] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const say = useToast()
  const router = useRouter()

  const first = view === 'first'
  const shards = first ? SHARDS_FIRST : SHARDS_RETURNING

  const submit = (q: string) => {
    if (!q) {
      say('Say what you need, or press Tab for the suggestion.')
      return
    }
    router.push(`/explore?q=${encodeURIComponent(q)}`)
  }

  return (
    <div className="bg-canvas relative h-[100dvh] w-full overflow-hidden md:min-h-[520px]">
      {/* Grid — everything on this page lands on its 72px pitch. */}
      <div
        className="pointer-events-none absolute inset-0 z-1"
        style={{
          backgroundImage:
            'linear-gradient(rgb(120 118 112 / 0.13) 1px,transparent 1px),linear-gradient(90deg,rgb(120 118 112 / 0.13) 1px,transparent 1px)',
          backgroundSize: 'var(--aiki-grid) var(--aiki-grid)',
          backgroundPosition: 'center center',
        }}
      />

      {/* Warm light, bottom-right and top-left. Blurred so it reads as light, not shape. */}
      <div className="pointer-events-none absolute -right-[100px] -bottom-[120px] z-2 h-[320px] w-[340px] rounded-[48%_52%_44%_56%] bg-[radial-gradient(ellipse_at_40%_40%,rgb(255_77_0_/_0.5),rgb(255_90_20_/_0.34)_45%,rgb(255_120_40_/_0)_72%)] blur-[28px] md:-right-[160px] md:-bottom-[190px] md:h-[560px] md:w-[620px]" />
      <div className="pointer-events-none absolute -top-[70px] -left-[60px] z-2 h-[190px] w-[210px] bg-[radial-gradient(ellipse_at_60%_60%,rgb(255_77_0_/_0.3),rgb(255_150_60_/_0)_70%)] blur-[26px] md:-top-[110px] md:-left-[90px] md:h-[300px] md:w-[340px]" />

      <div className="pointer-events-none absolute top-[46%] left-1/2 z-3 h-[min(46vh,340px)] w-[min(46vw,600px)] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgb(250_250_248_/_0.96)_0%,rgb(250_250_248_/_0.8)_45%,rgb(250_250_248_/_0.4)_70%,rgb(250_250_248_/_0)_90%)]" />

      <ShardField shards={shards} onPick={(name) => router.push(agentHref(name.toLowerCase()))} />

      <div className="pointer-events-none absolute top-[46%] left-1/2 z-20 h-[min(52vh,400px)] w-[min(52vw,700px)] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgb(250_250_248_/_0.97)_0%,rgb(250_250_248_/_0.9)_38%,rgb(250_250_248_/_0.55)_62%,rgb(250_250_248_/_0)_86%)]" />

      <Image
        src="/aiki-logo.png"
        alt="AiKi"
        width={120}
        height={120}
        priority
        className="absolute top-3 left-4 z-40 h-[38px] w-auto md:top-4 md:left-6 md:h-[50px]"
      />

      <StatusCluster first={first} onSay={say} />
      <HistoryRail
        onOpenChange={setHistoryOpen}
        onResume={(ask) => {
          setResumed((n) => n + 1)
          say(`Reopening “${ask}”.`)
        }}
      />

      <div className="absolute top-[46%] left-1/2 z-30 flex w-[calc(100vw-32px)] max-w-[660px] -translate-x-1/2 -translate-y-[52%] flex-col items-center lg:w-[clamp(420px,calc(100vw-700px),660px)]">
        <div className="text-[14px] leading-[1.4] font-semibold whitespace-nowrap text-[#8A8A8A]">
          {first ? `Welcome to AiKi, ${userName}` : `Good morning, ${userName}`}
        </div>
        <h1 className="mt-[9px] max-w-full text-center text-[clamp(30px,7vw,54px)] leading-[1.02] font-extrabold tracking-[-0.036em] text-balance">
          What do you need done?
        </h1>

        <AskField
          key={resumed}
          onSubmit={submit}
          onPick={(t: Task) => say(`Finding agents for “${t.intent}”.`)}
        />

        {first ? (
          <Link
            href={route('/welcome')}
            className="mt-4 text-[12.5px] font-medium text-[#767676] hover:text-[#141414]"
          >
            New here?{' '}
            <span className="font-bold underline underline-offset-[3px]">Take the walkthrough</span>
          </Link>
        ) : (
          <div className="mt-4 text-[12.5px] font-medium text-[#767676]">
            Tab to use suggestion · Enter to find agents
          </div>
        )}
      </div>

      <div className="pointer-events-none fixed inset-x-4 bottom-[54px] z-25 flex justify-center text-center md:inset-x-auto md:right-6 md:bottom-[18px] md:justify-end md:text-right">
        <Link
          href={route('/how-we-test')}
          className="pointer-events-auto border-0 bg-none text-[12.5px] font-medium text-[#767676] hover:text-[#141414]"
        >
          Every agent here is tested by AiKi itself.{' '}
          <span className="font-bold underline underline-offset-[3px]">how we test</span>
        </Link>
      </div>

      {/* First run vs returning is normally derived from whether you have agents.
          It stays switchable here so the difference can be shown, not described. */}
      <div
        className="fixed right-3 bottom-4 z-46 flex gap-[2px] rounded-[12px] bg-[rgb(20_20_20_/_0.05)] p-[3px] transition-opacity md:right-auto md:left-6"
        style={historyOpen ? { opacity: 0, pointerEvents: 'none' } : undefined}
      >
        {(['returning', 'first'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setView(k)}
            className="h-[26px] rounded-[9px] border-0 px-[10px] text-[11px] font-semibold"
            style={
              view === k
                ? {
                    background: '#fff',
                    color: '#141414',
                    boxShadow: '0 2px 6px rgb(20 20 20 / 0.12)',
                  }
                : { background: 'transparent', color: '#767676' }
            }
          >
            {k === 'returning' ? 'Returning' : 'First run'}
          </button>
        ))}
      </div>
    </div>
  )
}
