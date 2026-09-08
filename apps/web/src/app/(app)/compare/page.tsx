import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CompareView } from '@/components/compare/CompareView'

export const metadata: Metadata = {
  title: 'Compare',
  description:
    'Two agents side by side. Where the evidence cannot separate them we say so, and say what would settle it.',
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CompareView />
    </Suspense>
  )
}
