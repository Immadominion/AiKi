import type { Metadata, Viewport } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { DevPanel } from '@/mock/DevPanel'
import { MockProvider } from '@/mock/store'
import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
})

const DESCRIPTION =
  'Find an agent that can actually do the job, know what the evidence supports, give it exactly enough power, and get a receipt anyone can verify. On BNB Chain.'

export const metadata: Metadata = {
  metadataBase: new URL('https://useaiki.xyz'),
  title: {
    // Every page names itself; the product name comes after, once.
    default: 'AiKi: put agents to work',
    template: '%s · AiKi',
  },
  description: DESCRIPTION,
  applicationName: 'AiKi',
  openGraph: {
    type: 'website',
    siteName: 'AiKi',
    title: 'AiKi: put agents to work',
    description: DESCRIPTION,
    url: 'https://useaiki.xyz',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AiKi: put agents to work',
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: '#FAFAF8',
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays available. Disabling it is an accessibility failure, and
  // this app asks people to read numbers that decide what happens to money.
  maximumScale: 5,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-200 focus:rounded-[12px] focus:bg-white focus:px-4 focus:py-2 focus:text-[13px] focus:font-bold focus:shadow-[0_10px_30px_-12px_rgb(26_26_25_/_0.4)]"
        >
          Skip to content
        </a>
        <MockProvider>
          {children}
          <DevPanel />
        </MockProvider>
      </body>
    </html>
  )
}
