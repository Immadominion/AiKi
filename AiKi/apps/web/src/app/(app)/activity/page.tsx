import type { Metadata } from 'next'
import { ActivityView } from '@/components/shell/ActivityView'

export const metadata: Metadata = {
  title: 'Activity',
  description:
    'Every action your agents took, including the ones that were refused. Each row has a transaction behind it.',
}

export default function Page() {
  return <ActivityView />
}
