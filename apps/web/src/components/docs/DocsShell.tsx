'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useLayoutPref } from '@/components/shell/prefs'
import { FAST_HOME, route } from '@/lib/routes'
import { DOC_GROUPS, DOCS } from './content'

/**
 * Docs get their own shell.
 *
 * They were living inside the dashboard, which meant reading about how AiKi
 * works required first being signed into it, and left the app's navigation
 * hovering over a page that has nothing to do with your agents. Docs are a
 * public surface: no wallet, no sidebar counts, no mode.
 */
export function DocsShell({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const { layout } = useLayoutPref()
  const [open, setOpen] = useState(false)

  const slug = path.split('/').filter(Boolean).at(-1) ?? ''
  const backHref = layout === 'fast' ? FAST_HOME : route('/market')

  const rail = (
    <nav className="flex flex-col gap-[20px]">
      {DOC_GROUPS.map((g) => (
        <div key={g}>
          <div className="text-muted-3 mb-[6px] px-[10px] text-[11.5px] font-semibold">{g}</div>
          <div className="flex flex-col gap-[2px]">
            {DOCS.filter((d) => d.group === g).map((d) => {
              const on = d.slug === slug
              return (
                <Link
                  key={d.slug}
                  href={route(`/docs/${d.slug}`)}
                  onClick={() => setOpen(false)}
                  className="rounded-[11px] px-[10px] py-[8px] text-[13px] leading-[1.35] transition-colors"
                  style={
                    on
                      ? { background: 'rgb(20 20 20 / 0.06)', color: '#141414', fontWeight: 700 }
                      : { color: '#57574F', fontWeight: 500 }
                  }
                >
                  {d.title}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )

  return (
    <div className="bg-canvas relative min-h-[100dvh] w-full">
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage:
            'linear-gradient(rgb(120 118 112 / 0.1) 1px,transparent 1px),linear-gradient(90deg,rgb(120 118 112 / 0.1) 1px,transparent 1px)',
          backgroundSize: 'var(--aiki-grid) var(--aiki-grid)',
          backgroundPosition: 'center center',
        }}
      />

      <header className="relative z-20 flex items-center gap-3 px-4 py-4 md:px-8">
        <Link href={route('/docs/getting-started')} className="flex items-center gap-[9px]">
          <Image
            src="/aiki-logo.png"
            alt="AiKi"
            width={80}
            height={80}
            className="h-[34px] w-auto"
          />
          <span className="text-[17px] font-extrabold tracking-[-0.02em]">Docs</span>
        </Link>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="h-9 rounded-[12px] border-0 bg-[rgb(20_20_20_/_0.05)] px-3 text-[13px] font-semibold lg:hidden"
        >
          {open ? 'Close' : 'Contents'}
        </button>

        <Link
          href={backHref}
          className="hidden h-9 items-center rounded-[12px] bg-[rgb(20_20_20_/_0.05)] px-[14px] text-[13px] font-bold text-[#141414] transition-colors hover:bg-[rgb(20_20_20_/_0.09)] sm:flex"
        >
          Open AiKi
        </Link>
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-[1140px] flex-col gap-[26px] px-4 pb-16 md:px-8 lg:flex-row lg:gap-[44px]">
        <aside
          className={`flex-none lg:sticky lg:top-4 lg:h-fit lg:w-[216px] ${open ? '' : 'hidden lg:block'}`}
        >
          {rail}
        </aside>
        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  )
}
