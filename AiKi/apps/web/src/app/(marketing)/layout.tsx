import type { Viewport } from 'next'
import { Archivo, IBM_Plex_Mono } from 'next/font/google'
import './marketing.css'

/*
 * iOS Safari tints the status bar and the bottom bar with theme-color. The
 * root layout's cool near-white does not match this page's warm ground, and
 * the mismatch shows on a device as a hard band the page cannot cover.
 */
export const viewport: Viewport = { themeColor: '#eee8db' }

import type { ReactNode } from 'react'

/**
 * The landing's own type system, scoped so the app shell keeps its font.
 *
 * Archivo is the working grotesque — tight, upright, nothing rounded about it —
 * and the mono is for captions that sit INSIDE the world: sweep dates, counts,
 * instrument text. Two voices: one speaks, one measures.
 */
const sans = Archivo({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
})

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${sans.variable} ${mono.variable}`} style={{ display: 'contents' }}>
      {children}
    </div>
  )
}
