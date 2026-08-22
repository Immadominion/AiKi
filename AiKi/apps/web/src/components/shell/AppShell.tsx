'use client'

import { PaletteProvider } from './CommandPalette'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <PaletteProvider>
      <div className="bg-tray text-ink-app flex h-screen min-h-0 w-screen min-w-0 gap-3 p-3">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <TopBar />
          {children}
        </div>
      </div>
    </PaletteProvider>
  )
}
