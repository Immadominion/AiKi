import type { Metadata } from 'next'
import { LimitsView } from '@/components/limits/LimitsView'

export const metadata: Metadata = {
  title: 'Limits',
  description:
    'Every rule you have handed out and who actually holds it: the chain, a signer, or only us.',
}

export default function Page() {
  return <LimitsView />
}
