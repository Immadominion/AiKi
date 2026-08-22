import type { Metadata } from 'next'
import { MissionControl } from '@/components/job/MissionControl'

export const metadata: Metadata = {
  title: 'Mission control',
  description:
    'What an agent is doing right now, what it was refused, and a stop button that costs nothing.',
}

export default function Page() {
  return <MissionControl />
}
