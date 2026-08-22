import type { Metadata } from 'next'
import { HowWeTest } from '@/components/evidence/HowWeTest'

export const metadata: Metadata = {
  title: 'How we test',
  description:
    'Our own probe sweep of the BNB Chain registry, the detection rules in plain language, and why a score is never a raw percentage.',
}

export default function Page() {
  return <HowWeTest />
}
