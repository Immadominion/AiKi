import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ExploreView } from '@/components/shell/ExploreView'

export const metadata: Metadata = {
  title: 'Explore',
  description:
    'Every agent we index on BNB Chain, ranked by evidence AiKi collected itself. Agents we could not verify are counted, not hidden.',
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ExploreView />
    </Suspense>
  )
}
