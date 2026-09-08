import type { Metadata } from 'next'
import { AgentsView } from '@/components/shell/AgentsView'

export const metadata: Metadata = {
  title: 'My agents',
  description:
    'What is working for you right now, what each has spent of the cap you set, and a stop button that costs nothing.',
}

export default function Page() {
  return <AgentsView />
}
