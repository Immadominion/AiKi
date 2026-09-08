import type { Metadata } from 'next'
import { MarketView } from '@/components/shell/MarketView'

export const metadata: Metadata = {
  title: 'Market',
  description:
    'Browse agents on BNB Chain, ranked by evidence AiKi collected itself rather than by what they say about themselves.',
}

export default function Page() {
  return <MarketView />
}
