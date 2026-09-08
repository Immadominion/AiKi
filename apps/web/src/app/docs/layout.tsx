import type { Metadata } from 'next'
import { DocsShell } from '@/components/docs/DocsShell'

export const metadata: Metadata = {
  title: { default: 'Docs', template: '%s · AiKi docs' },
  description: 'Find providers, hire for a job, follow the work and build with AiKi.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>
}
