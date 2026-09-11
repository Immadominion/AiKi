'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useAccount } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  claimPendingFastAsk,
  parsePendingFastAsk,
  serializePendingFastAsk,
} from '@/lib/fast-pending-ask'
import { agentHref, registryHref } from '@/lib/routes'
import type { Task } from '@/lib/tasks'
import { useProbeExpiry } from '@/lib/use-probe-expiry'
import { AskField } from './AskField'
import { FastChat } from './FastChat'
import { FastChatHeader } from './FastChatHeader'
import { HistoryRail } from './HistoryRail'
import { liveShards } from './live-shards'
import { ShardField } from './ShardField'
import type { Frame } from './shards'

const PENDING_ASK_KEY = 'aiki.fast.pending-ask'

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
  userName,
  footer,
  landmark = false,
  fullScreen = false,
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
  /** The overlay also has a floating navigation control in its left corner. */
  fullScreen?: boolean
}) {
  const account = useAccount()
  /*
   * The question that opened Fast mode, if one has. Asking used to redirect to
   * a search results page, which made "Fast" a differently-shaped search box
   * rather than a different way of working: a search cannot preview limits,
   * create a mandate, or put an agent on duty, and those are the things people
   * come here to do.
   */
  const [chat, setChat] = useState<{ id: string; opening?: string; create?: boolean } | null>(null)
  const [restoredAsk, setRestoredAsk] = useState('')
  const say = useToast()
  const router = useRouter()
  useEffect(() => {
    const restore = () => {
      const id = new URL(window.location.href).searchParams.get('conversation')
      setChat(
        account.authenticated && account.address && id && /^[0-9a-f-]{36}$/i.test(id)
          ? { id }
          : null,
      )
    }
    restore()
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [account.authenticated, account.address])
  const openChat = (next: { id: string; opening?: string; create?: boolean } | null) => {
    const url = new URL(window.location.href)
    if (next) url.searchParams.set('conversation', next.id)
    else url.searchParams.delete('conversation')
    window.history.replaceState(null, '', url)
    setChat(next)
  }
  useEffect(() => {
    try {
      const stored = parsePendingFastAsk(sessionStorage.getItem(PENDING_ASK_KEY))
      const pending = stored
        ? claimPendingFastAsk(stored, account.connected ? account.address : null)
        : null
      if (!pending) return
      if (pending.owner !== stored?.owner) {
        sessionStorage.setItem(PENDING_ASK_KEY, serializePendingFastAsk(pending))
      }
      setRestoredAsk((current) => current || pending.text)
      if (account.authenticated) {
        sessionStorage.removeItem(PENDING_ASK_KEY)
        say('Signed in. Your question is ready to send.')
      }
    } catch {
      /* A blocked session store should never block Fast mode. */
    }
  }, [account.authenticated, account.connected, account.address, say])

  /*
   * The cards are the registry, not a picture of one.
   *
   * These were six invented agents with invented probe counts, sitting under a
   * line promising that everything on this page is measured. A visitor had no
   * way to tell that Guardian and its 174 checks were not in the registry, and
   * on a product whose whole argument is that nobody else checks, that is the
   * most expensive thing on the screen to get wrong.
   *
   * `live` is null until the answer arrives and stays null if it never does.
   * The field renders empty in that case, deliberately: an empty marketplace is
   * a true statement about a marketplace we cannot currently read, and the
   * fixtures were not.
   */
  const [live, setLive] = useState<ProjectedPassport[] | null>(null)
  useProbeExpiry((live ?? []).map((passport) => passport.lastProbeAt))
  useEffect(() => {
    let cancelled = false
    api
      // Drawn wide because one operator holds most of the answering agents;
      // six distinct names need more than six rows to find.
      .search({ limit: 60 })
      .then((answer) => {
        if (!cancelled) setLive(answer.results)
      })
      .catch(() => {
        if (!cancelled) setLive([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const first = !connected
  const shards = liveShards(live ?? [])

  const submit = (q: string) => {
    if (!q) {
      say('Say what you need, or press Tab for the suggestion.')
      return
    }
    if (!account.authenticated) {
      try {
        sessionStorage.setItem(
          PENDING_ASK_KEY,
          serializePendingFastAsk({
            text: q,
            owner: account.connected ? account.address : null,
          }),
        )
      } catch {
        /* The field still stays visible while this component remains mounted. */
      }
      say('Sign in with your wallet, then send your message.')
      void account
        .connect()
        .then((outcome) => {
          if (outcome === 'injected') return
          say(
            outcome === 'unsigned'
              ? 'Your question is still here. Sign in when you are ready to send it.'
              : 'Your question is still here. Connect a wallet when you are ready.',
          )
        })
        .catch((error: Error) => {
          say(error.message)
        })
      return
    }
    try {
      sessionStorage.removeItem(PENDING_ASK_KEY)
    } catch {
      /* Sending does not depend on clearing convenience state. */
    }
    setRestoredAsk('')
    openChat({ id: crypto.randomUUID(), opening: q, create: true })
  }

  if (chat !== null && account.authenticated)
    return (
      <div className="absolute inset-0 z-30 flex min-h-0 flex-col px-[18px] pt-[18px] pb-[108px] md:pb-[54px]">
        <FastChatHeader fullScreen={fullScreen}>
          <button
            type="button"
            onClick={() => openChat(null)}
            className="text-muted min-h-10 shrink-0 border-0 bg-none text-[12.5px] font-semibold hover:text-ink-app focus-visible:outline-2 focus-visible:outline-orange-app"
          >
            ← Back
          </button>
          <HistoryRail
            inline
            authenticated={account.authenticated}
            activeId={chat.id}
            onResume={(id) => openChat({ id })}
            onNew={() => openChat({ id: crypto.randomUUID(), create: true })}
          />
        </FastChatHeader>
        <FastChat
          key={chat.id}
          id={chat.id}
          owner={account.address}
          {...(chat.opening ? { opening: chat.opening } : {})}
          create={chat.create ?? false}
          onClose={() => openChat(null)}
        />
      </div>
    )

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
        /*
         * A real agent is addressed by its token id, which is the page that
         * carries the evidence: every probe, the score floor and its interval,
         * and the reciprocal proof. Only the remaining fixture cards still
         * route by name, and they are the ones that were named after routes.
         */
        onPick={(shard) =>
          router.push(
            shard.agentId ? registryHref(shard.agentId) : agentHref(shard.name.toLowerCase()),
          )
        }
      />

      <div
        className={`pointer-events-none absolute top-[46%] left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgb(250_250_248_/_0.97)_0%,rgb(250_250_248_/_0.9)_38%,rgb(250_250_248_/_0.55)_62%,rgb(250_250_248_/_0)_86%)] ${frame.vignetteOuter}`}
      />

      <HistoryRail
        authenticated={account.authenticated}
        onResume={(id) => openChat({ id })}
        onNew={() => openChat({ id: crypto.randomUUID(), create: true })}
      />

      <Hero landmark={landmark} className={frame.heroClass}>
        {/*
          A stranger got "Welcome to AiKi" here, which is a greeting and not an
          answer: nothing above the fold said what this was, what an agent would
          do for them, or why a chain was involved. The eyebrow now names the
          category and the line under the field gives the reason, so the page
          can be understood without scrolling or connecting anything.

          Not nowrap any more. The old string was short enough to get away with
          it and this one is not, and a clipped first sentence is worse than a
          wrapped one.
        */}
        <div className={`leading-[1.4] font-semibold text-[#8A8A8A] ${frame.greetClass}`}>
          {first
            ? 'An agent marketplace on BNB Chain'
            : userName
              ? `Welcome back, ${userName}`
              : 'Welcome back'}
        </div>
        <h1
          className={`mt-[9px] max-w-full text-center leading-[1.02] font-extrabold tracking-[-0.036em] text-balance ${frame.titleClass}`}
        >
          What do you need done?
        </h1>

        <AskField
          onSubmit={submit}
          onPick={(t: Task) => say(`Finding agents for “${t.intent}”.`)}
          initialValue={restoredAsk}
          onValueChange={(value) => {
            setRestoredAsk(value)
            try {
              const pending = parsePendingFastAsk(sessionStorage.getItem(PENDING_ASK_KEY))
              if (!pending) return
              const claimed = claimPendingFastAsk(
                pending,
                account.connected ? account.address : null,
              )
              if (!claimed) return
              if (value.trim()) {
                sessionStorage.setItem(
                  PENDING_ASK_KEY,
                  serializePendingFastAsk({ ...claimed, text: value }),
                )
              } else {
                sessionStorage.removeItem(PENDING_ASK_KEY)
              }
            } catch {
              /* Editing remains local if the session store is blocked. */
            }
          }}
          disabled={account.connecting}
        />

        {/*
          Careful about the tier. It says you keep the wallet and you get a
          receipt, both of which are true today. It does NOT say the chain
          refuses, because no enforcer of ours is deployed anywhere yet. Upgrade
          this sentence when that changes and not before.
        */}
        {first ? (
          <p className="text-muted mt-[14px] mb-0 max-w-[430px] text-center text-[13px] leading-[1.55] text-pretty">
            Hire one with a limit you set. AiKi never holds your wallet, and every action it takes,
            including the ones it was refused, lands in a receipt you can check yourself.
          </p>
        ) : null}

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
