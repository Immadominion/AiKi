import type { Metadata } from 'next'
import { Welcome } from '@/components/onboarding/Welcome'

export const metadata: Metadata = {
  title: 'Get started',
  description:
    "Connect a wallet, pick what you need done, and see the whole of an agent's authority on one screen before anything is signed.",
}

export default function Page() {
  return <Welcome />
}
