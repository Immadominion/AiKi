import type { Metadata } from 'next'
import { CreditsView } from '@/components/credits/CreditsView'

export const metadata: Metadata = {
  title: 'Points',
  description: 'Your AiKi point balance, Fast mode limits, and payment history.',
}

export default function Page() {
  return <CreditsView />
}
