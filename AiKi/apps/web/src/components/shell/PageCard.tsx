'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { route } from '@/lib/routes'

export interface Banner {
  title: string
  body: string
  cta: string
  onAction?: (() => void) | undefined
}

/**
 * The white card every app page lives inside.
 *
 * Header, tabs, banner and body are one component rather than four because their
 * spacing is interlocked — the divider bleeds to the card edge, and the banner
 * only exists in the gap between the tabs and the scroll region.
 */
export function PageCard({
  title,
  count,
  primary,
  onPrimary,
  headerSlot,
  back,
  tabs,
  tabHint,
  banner,
  panels,
  children,
}: {
  title: string
  count: string
  primary?: string | undefined
  onPrimary?: (() => void) | undefined
  /** Replaces the title row entirely. Detail pages lead with the thing itself. */
  headerSlot?: React.ReactNode | undefined
  back?: { href: string; label: string } | undefined
  tabs: string[]
  tabHint: React.ReactNode
  banner?: Banner | undefined
  /** One node per tab. When given, tabs switch panels instead of announcing. */
  panels?: React.ReactNode[] | undefined
  children?: React.ReactNode
}) {
  const [tab, setTab] = useState(0)
  const say = useToast()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]">
      <div className="flex-none px-[22px] pt-[18px]">
        {back ? (
          <Link
            href={route(back.href)}
            className="text-muted hover:text-ink-app mb-[10px] inline-flex items-center gap-[6px] text-[12.5px] font-semibold transition-colors"
          >
            <span aria-hidden>←</span> {back.label}
          </Link>
        ) : null}
        {headerSlot ?? (
          <div className="flex items-baseline gap-[9px]">
            <span className="text-[19px] font-extrabold tracking-[-0.02em]">{title}</span>
            <span className="text-faint-2 text-[13px] font-semibold">·</span>
            <span className="text-muted text-[13.5px] font-semibold">{count}</span>
            <div className="flex-1" />
            {primary ? (
              <button
                type="button"
                onClick={onPrimary ?? (() => say(`“${primary}” is wired in the build.`))}
                className="bg-ink-app hover:bg-orange-app h-[38px] rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors"
              >
                {primary}
              </button>
            ) : null}
          </div>
        )}
        <div className="-mx-[22px] mt-4 h-px bg-[rgb(26_26_25_/_0.07)]" />
      </div>

      {tabs.length > 0 ? (
        <div className="flex flex-none items-center gap-[14px] px-[22px] pt-4">
          <div className="flex gap-[3px] rounded-[14px] bg-[rgb(26_26_25_/_0.05)] p-1">
            {tabs.map((t, i) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTab(i)
                  if (!panels && i > 0)
                    say(
                      `“${t}” filtering is wired in the build — this pass shows the default view.`,
                    )
                }}
                className="h-9 rounded-[11px] border-0 px-[18px] text-[14px]"
                style={
                  tab === i
                    ? {
                        background: '#fff',
                        color: 'var(--color-ink-app)',
                        fontWeight: 700,
                        boxShadow: '0 1px 2px rgb(26 26 25 / 0.1)',
                      }
                    : { background: 'transparent', color: 'var(--color-muted-2)', fontWeight: 600 }
                }
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <span className="text-muted text-[12.5px] font-semibold">{tabHint}</span>
        </div>
      ) : null}

      {banner ? (
        <div className="mx-[22px] mt-4 flex-none rounded-2xl bg-[linear-gradient(90deg,#FF5A00,#A855F7_55%,#3B82F6)] p-[1.5px]">
          <div className="flex items-center gap-[11px] rounded-[14.5px] bg-white px-[15px] py-[13px]">
            <span className="flex-none text-[15px] text-[#A855F7]">✦</span>
            <span className="text-body-2 min-w-0 flex-1 text-[13.5px] leading-[1.45]">
              <b className="text-ink-app font-bold">{banner.title}</b> {banner.body}
            </span>
            <button
              type="button"
              onClick={
                banner.onAction ??
                (() => say('Opens the reasoning behind this — evidence, positions, and limits.'))
              }
              className="h-8 flex-none rounded-[10px] border-0 bg-[rgb(26_26_25_/_0.055)] px-[13px] text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
            >
              {banner.cta}
            </button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-4 pb-[22px]">
        {panels ? panels[tab] : children}
      </div>
    </div>
  )
}
