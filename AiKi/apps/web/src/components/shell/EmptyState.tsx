'use client'

import { useRouter } from 'next/navigation'
import { route } from '@/lib/routes'

/**
 * What a surface says when there is genuinely nothing on it.
 *
 * Never "no data" — that describes our situation, not theirs. Each of these
 * says what the emptiness means and what would fill it, because the first
 * screen a new person sees is the one that decides whether they try anything.
 */
export function EmptyState({
  title,
  body,
  action,
  href,
  secondary,
}: {
  title: string
  body: string
  action?: string
  href?: string
  secondary?: string
}) {
  const router = useRouter()

  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[24px]">
      <div className="text-[14.5px] font-bold">{title}</div>
      <p className="text-muted mt-[6px] mb-0 max-w-[580px] text-[13px] leading-[1.55] text-pretty">
        {body}
      </p>
      {action && href ? (
        <button
          type="button"
          onClick={() => router.push(route(href))}
          className="bg-ink-app hover:bg-orange-app mt-[16px] h-[38px] rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors"
        >
          {action}
        </button>
      ) : null}
      {secondary ? (
        <p className="text-faint mt-[12px] mb-0 max-w-[580px] text-[12px] leading-[1.5] text-pretty">
          {secondary}
        </p>
      ) : null}
    </div>
  )
}

/** The wallet is not connected, so there is nothing of yours to show. */
export function NoWallet({ what }: { what: string }) {
  return (
    <EmptyState
      title="No wallet connected."
      body={`Connect one and ${what} appears here. Connecting only lets AiKi read your balances — no agent can touch anything until you sign an authority with limits you set yourself.`}
      action="Connect a wallet"
      href="/welcome"
      secondary="You can browse every agent we index without connecting anything."
    />
  )
}
