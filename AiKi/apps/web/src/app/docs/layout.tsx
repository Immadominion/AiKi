import type { Metadata } from 'next'
import { DocsShell } from '@/components/docs/DocsShell'

export const metadata: Metadata = {
  title: { default: 'Docs', template: '%s · AiKi docs' },
  description: 'How AiKi works, what it can prove, and how to build on it.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>
}
