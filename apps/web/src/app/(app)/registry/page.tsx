import type { Metadata } from 'next'
import { RegistryView } from '@/components/registry/RegistryView'

export const metadata: Metadata = {
  title: 'Registry',
  description:
    'The BSC ERC-8004 registry as AiKi measured it: the agents that answered, and an honest count of the ones that did not.',
}

export default function Page() {
  return <RegistryView />
}
