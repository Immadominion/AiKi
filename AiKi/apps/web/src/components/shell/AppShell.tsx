'use client'

import { useState } from 'react'
import { ManualRun } from '@/components/onboarding/ManualRun'
import { PaletteProvider } from './CommandPalette'
import { useSidebar } from './prefs'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

/**
 * The app frame.
 *
 * On a phone the sidebar is a drawer rather than a column — at 390px a 200px
 * sidebar leaves nothing to look at. The collapse preference is a desktop idea
 * and is deliberately ignored there: the drawer is always full width when open,
 * because a 60px rail of glyphs is worse on touch than no rail at all.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { collapsed, toggle } = useSidebar()
  const [navOpen, setNavOpen] = useState(false)

  return (
    <PaletteProvider>
      {/* The tray is the same surface Fast mode uses, so it carries the same
          grid. It only shows in the margins and behind the sidebar, because
          every panel sitting on it is opaque. */}
      <div
        className="bg-tray text-ink-app flex h-[100dvh] min-h-0 w-full min-w-0 gap-0 p-2 md:gap-3 md:p-3"
        style={{
          backgroundImage:
            'linear-gradient(rgb(120 118 112 / 0.11) 1px,transparent 1px),linear-gradient(90deg,rgb(120 118 112 / 0.11) 1px,transparent 1px)',
          backgroundSize: 'var(--aiki-grid) var(--aiki-grid)',
          backgroundPosition: 'center center',
        }}
      >
        {navOpen ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-60 cursor-default border-0 bg-[rgb(26_26_25_/_0.35)] md:hidden"
          />
        ) : null}

        <div
          data-shell-chrome
          className={`bg-tray md:bg-transparent fixed inset-y-2 left-2 z-70 w-[264px] flex-none rounded-[20px] shadow-[0_24px_60px_-20px_rgb(26_26_25_/_0.4)] transition-transform duration-200 md:static md:z-auto md:inset-auto md:w-[var(--sb-w)] md:rounded-none md:shadow-none md:transition-[width] md:duration-300 md:ease-[cubic-bezier(0.22,1,0.36,1)] ${
            navOpen ? 'translate-x-0' : '-translate-x-[110%] md:translate-x-0'
          }`}
          style={{ ['--sb-w' as string]: collapsed ? '60px' : 'clamp(196px,19vw,252px)' }}
        >
          {/* The width lives on the flex child above, not here. With it on an
              inner div the column stayed 264px and collapsing moved nothing. */}
          <div className="h-full w-full overflow-hidden">
            <Sidebar collapsed={collapsed} onToggle={toggle} onNavigate={() => setNavOpen(false)} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 md:gap-3">
          <div data-shell-chrome>
            <TopBar onMenu={() => setNavOpen(true)} />
          </div>
          <main id="main" className="flex min-h-0 flex-1 flex-col">
            {children}
          </main>
        </div>
        <ManualRun />
      </div>
    </PaletteProvider>
  )
}
