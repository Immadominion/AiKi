'use client'

import { useRouter } from 'next/navigation'
import { useLayoutPref } from '@/components/shell/layout-pref'
import { MarketGrid } from '@/components/shell/MarketCard'
import { PageCard } from '@/components/shell/PageCard'
import { useToast } from '@/components/ui/Toast'
import { AGENTS } from '@/lib/agents'

/**
 * The market home — the alternative to the single question.
 *
 * Same agents as Explore, shown as cards rather than rows, because this is the
 * browsing surface: you arrive without a task in mind and read descriptions.
 */
export default function MarketPage() {
  const { layout } = useLayoutPref()
  const say = useToast()
  const router = useRouter()
  const ask = layout === 'ask'

  return (
    <PageCard
      title="Home"
      count={ask ? 'One ask layout' : 'Market layout'}
      primary={ask ? 'Open one-ask' : 'Hire agent'}
      onPrimary={ask ? () => router.push('/') : undefined}
      tabs={['All agents', 'For your positions', 'New']}
      tabHint="12 agents claim work today"
      banner={{
        title: `Your layout is set to ${ask ? '“One ask”.' : '“Market”.'}`,
        body: ask
          ? 'The full-screen ask page is your home — this market view stays one click away.'
          : 'You browse the market first. Switch back whenever you want the single question.',
        cta: 'Change',
        onAction: () => say('Switch layouts from the Home layout control in the sidebar.'),
      }}
    >
      <MarketGrid
        agents={AGENTS}
        footnote="Every agent here is tested by AiKi itself. Empty bars mean missing evidence, not bad performance."
      />
    </PageCard>
  )
}
