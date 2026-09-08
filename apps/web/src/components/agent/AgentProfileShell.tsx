'use client'

import { ArrowLeftIcon, GitCompareArrowsIcon, HeartIcon } from 'lucide-react'
import Link from 'next/link'
import { route } from '@/lib/routes'

export function AgentProfileShell({
  tokenId,
  passport,
  children,
  onSave,
  onCompare,
  saved,
}: {
  tokenId: string
  passport: React.ReactNode
  children: React.ReactNode
  onSave: () => void
  onCompare: () => void
  saved: boolean
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]">
      <header className="flex min-h-[54px] flex-none items-center gap-2 border-b border-[rgb(26_26_25_/_0.07)] px-3 sm:px-[18px]">
        <Link
          href={route('/explore')}
          className="text-muted hover:text-ink-app -ml-1 inline-flex min-h-10 cursor-pointer items-center gap-1.5 px-1 text-[11.5px] font-semibold transition-colors duration-100"
        >
          <ArrowLeftIcon aria-hidden size={14} strokeWidth={2} />
          Explore
        </Link>
        <span aria-hidden className="text-faint text-[11px]">
          /
        </span>
        <span className="text-body min-w-0 truncate text-[11.5px] font-bold">
          <span className="sm:hidden">Agent {tokenId}</span>
          <span className="hidden sm:inline">BNB Chain · Agent {tokenId}</span>
        </span>
        <span className="text-muted inline-flex flex-none rounded-full border border-[rgb(26_26_25_/_0.09)] px-2 py-1 text-[7px] font-bold tracking-[0.04em] uppercase sm:text-[8px]">
          <span className="sm:hidden">Example</span>
          <span className="hidden sm:inline">Example agent</span>
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onSave}
          aria-pressed={saved}
          className="text-body hover:text-ink-app inline-flex h-10 min-w-10 cursor-pointer items-center justify-center gap-1.5 rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.05)] px-2.5 text-[10.5px] font-bold transition-colors duration-100 active:translate-y-px sm:px-3"
        >
          <HeartIcon aria-hidden size={14} strokeWidth={2} fill={saved ? 'currentColor' : 'none'} />
          <span className="hidden sm:inline">{saved ? 'Saved' : 'Save'}</span>
        </button>
        <button
          type="button"
          onClick={onCompare}
          className="text-body hover:text-ink-app inline-flex h-10 min-w-10 cursor-pointer items-center justify-center gap-1.5 rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.05)] px-2.5 text-[10.5px] font-bold transition-colors duration-100 active:translate-y-px sm:px-3"
        >
          <GitCompareArrowsIcon aria-hidden size={14} strokeWidth={2} />
          <span className="hidden sm:inline">Compare</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid items-start gap-3 p-3 sm:gap-4 sm:p-4 lg:grid-cols-[minmax(258px,296px)_minmax(0,1fr)] min-[1180px]:gap-[18px] min-[1180px]:px-[18px] min-[1180px]:pb-[18px]">
          {passport}
          {children}
        </div>
      </div>
    </section>
  )
}
