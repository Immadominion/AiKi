import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AiKi — put agents to work',
  description:
    'Find the right agent. Know it works. Give it exactly enough power. Let it execute. Prove what happened.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Bricolage Grotesque = display (≥28px only). Inter = UI. Martian Mono = hashes. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Inter:wght@400;500;600&family=Martian+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
