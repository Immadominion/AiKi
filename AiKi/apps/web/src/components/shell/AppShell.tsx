'use client'

import { useState } from 'react'
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
      <div className="bg-tray text-ink-app flex h-[100dvh] min-h-0 w-full min-w-0 gap-0 p-2 md:gap-3 md:p-3">
        {navOpen ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-60 cursor-default border-0 bg-[rgb(26_26_25_/_0.35)] md:hidden"
          />
        ) : null}

        <div
          className={`bg-tray fixed inset-y-2 left-2 z-70 w-[264px] flex-none rounded-[20px] shadow-[0_24px_60px_-20px_rgb(26_26_25_/_0.4)] transition-transform duration-200 md:static md:z-auto md:inset-auto md:rounded-none md:shadow-none md:transition-[width] ${
            navOpen ? 'translate-x-0' : '-translate-x-[110%] md:translate-x-0'
          }`}
          style={{ ['--sb-w' as string]: collapsed ? '60px' : 'clamp(196px,19vw,252px)' }}
        >
          <div className="h-full w-full md:w-[var(--sb-w)]">
            <Sidebar collapsed={collapsed} onToggle={toggle} onNavigate={() => setNavOpen(false)} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 md:gap-3">
          <TopBar onMenu={() => setNavOpen(true)} />
          {children}
        </div>
      </div>
    </PaletteProvider>
  )
}
