'use client'

import Link from 'next/link'
import { useState } from 'react'
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
 * spacing is interlocked - the divider bleeds to the card edge, and the banner
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
  contentRef,
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
  /** One hint, or one per tab when the tabs change what is shown. */
  tabHint: React.ReactNode | React.ReactNode[]
  banner?: Banner | undefined
  /** One node per tab. When given, tabs switch panels instead of announcing. */
  panels?: React.ReactNode[] | undefined
  contentRef?: React.Ref<HTMLDivElement> | undefined
  children?: React.ReactNode
}) {
  const [tab, setTab] = useState(0)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]">
      <div className="flex-none px-4 pt-[18px] md:px-[22px]">
        {back ? (
          <Link
            href={route(back.href)}
            className="text-muted hover:text-ink-app mb-[10px] inline-flex min-h-10 items-center gap-[6px] text-[12.5px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-orange-app"
          >
            <span aria-hidden>←</span> {back.label}
          </Link>
        ) : null}
        {headerSlot ?? (
          <div className="flex flex-wrap items-baseline gap-x-[9px] gap-y-2">
            <h1 className="m-0 text-[19px] font-extrabold tracking-[-0.02em]">{title}</h1>
            {count ? <span className="text-muted text-[13.5px] font-semibold">{count}</span> : null}
            <div className="flex-1" />
            {primary && onPrimary ? (
              <button
                type="button"
                onClick={onPrimary}
                className="bg-ink-app hover:bg-orange-app min-h-10 rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
              >
                {primary}
              </button>
            ) : null}
          </div>
        )}
        <div className="-mx-4 mt-4 h-px bg-[rgb(26_26_25_/_0.07)] md:-mx-[22px]" />
      </div>

      {tabs.length > 0 && panels ? (
        <div className="flex-none px-4 pt-4 md:px-[22px]">
          <div className="flex items-center gap-[14px]">
            {/* The tab strip scrolls on its own. The hint used to live inside
                that scroller and got crushed to 60px on a phone, so it now sits
                outside it and drops to its own line when there is no room. */}
            <div className="min-w-0 overflow-x-auto">
              <div className="flex w-max gap-[3px] rounded-[14px] bg-[rgb(26_26_25_/_0.05)] p-1">
                {tabs.map((t, i) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={tab === i}
                    onClick={() => setTab(i)}
                    className="min-h-10 rounded-[11px] border-0 px-3 text-[13.5px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-orange-app md:px-[18px] md:text-[14px]"
                    style={
                      tab === i
                        ? {
                            background: '#fff',
                            color: 'var(--color-ink-app)',
                            fontWeight: 700,
                            boxShadow: '0 1px 2px rgb(26 26 25 / 0.1)',
                          }
                        : {
                            background: 'transparent',
                            color: 'var(--color-muted-2)',
                            fontWeight: 600,
                          }
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1" />
            <span className="text-muted hidden flex-none text-[12.5px] font-semibold whitespace-nowrap lg:block">
              {Array.isArray(tabHint) ? tabHint[tab] : tabHint}
            </span>
          </div>
          <span className="text-muted mt-[10px] block text-[12.5px] font-semibold text-pretty lg:hidden">
            {Array.isArray(tabHint) ? tabHint[tab] : tabHint}
          </span>
        </div>
      ) : null}

      {banner ? (
        <div className="mx-4 mt-4 flex-none rounded-2xl md:mx-[22px] bg-[linear-gradient(90deg,#FF5A00,#A855F7_55%,#3B82F6)] p-[1.5px]">
          <div className="flex items-center gap-[11px] rounded-[14.5px] bg-white px-[15px] py-[13px]">
            <span className="flex-none text-[15px] text-[#A855F7]">✦</span>
            <span className="text-body-2 min-w-0 flex-1 text-[13.5px] leading-[1.45]">
              <b className="text-ink-app font-bold">{banner.title}</b> {banner.body}
            </span>
            {banner.onAction ? (
              <button
                type="button"
                onClick={banner.onAction}
                className="min-h-10 flex-none rounded-[10px] border-0 bg-[rgb(26_26_25_/_0.055)] px-[13px] text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] focus-visible:outline-2 focus-visible:outline-orange-app"
              >
                {banner.cta}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div
        ref={contentRef}
        data-page-scroll
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-[22px] md:px-[22px]"
      >
        {panels ? panels[tab] : children}
      </div>
    </div>
  )
}
