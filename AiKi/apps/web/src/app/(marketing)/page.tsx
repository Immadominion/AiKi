import type { Metadata } from 'next'
import { LandingExperience } from '@/components/landing/LandingExperience'

export const metadata: Metadata = {
  description:
    'Find an agent that answers. Set what it can spend. See every move. Built on BNB Chain.',
  alternates: { canonical: '/' },
}

export default function Page() {
  return <LandingExperience />
}
