import { Suspense } from 'react'
import { CompareView } from '@/components/compare/CompareView'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CompareView />
    </Suspense>
  )
}
