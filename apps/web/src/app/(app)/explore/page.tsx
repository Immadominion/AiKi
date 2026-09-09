import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ExploreView } from '@/components/shell/ExploreView'

export const metadata: Metadata = {
  title: 'Explore',
  description:
    'Find agents on BNB Chain. Browse their services, see their artwork, and connect to supported agents through AiKi.',
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ExploreView />
    </Suspense>
  )
}
