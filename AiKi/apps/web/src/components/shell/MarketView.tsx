'use client'

import { useRouter } from 'next/navigation'
import { MarketGrid } from '@/components/shell/MarketCard'
import { PageCard } from '@/components/shell/PageCard'
import { useLayoutPref } from '@/components/shell/prefs'
import { AGENTS } from '@/lib/agents'

/**
 * The market home — the alternative to the single question.
 *
 * Same agents as Explore, shown as cards rather than rows, because this is the
 * browsing surface: you arrive without a task in mind and read descriptions.
 */
export function MarketView() {
  const { layout } = useLayoutPref()
  const router = useRouter()
  const fast = layout === 'fast'

  return (
    <PageCard
      title="Home"
      count={fast ? 'Fast mode is your home' : 'Manual mode is your home'}
      primary={fast ? 'Open Fast mode' : 'Hire agent'}
      onPrimary={fast ? () => router.push('/') : undefined}
      tabs={['All agents', 'For your positions', 'New']}
      tabHint="12 agents claim work today"
    >
      <MarketGrid
        agents={AGENTS}
        footnote="Every agent here is tested by AiKi itself. Empty bars mean missing evidence, not bad performance."
      />
    </PageCard>
  )
}
