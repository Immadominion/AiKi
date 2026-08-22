'use client'

import { useRouter } from 'next/navigation'
import { MarketGrid } from '@/components/shell/MarketCard'
import { PageCard } from '@/components/shell/PageCard'
import { useSaved } from '@/components/shell/prefs'
import { AGENTS } from '@/lib/agents'
import { route } from '@/lib/routes'

export function SavedView() {
  const { saved } = useSaved()
  const router = useRouter()
  const agents = AGENTS.filter((a) => saved.includes(a.key))

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <div className="min-w-0 flex-1 basis-[240px]">
        <span className="block text-[19px] font-extrabold tracking-[-0.02em]">Saved</span>
        <p className="text-muted mt-[3px] mb-0 max-w-[620px] text-[13px] leading-[1.45] text-pretty">
          Agents you wanted to come back to. Kept in this browser and nowhere else — what you are
          interested in is not something we need to know.
        </p>
      </div>
      <button
        type="button"
        onClick={() => router.push(route('/explore'))}
        className="text-ink-app h-[38px] w-full flex-none rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-4 text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] sm:w-auto"
      >
        Find agents
      </button>
    </div>
  )

  return (
    <PageCard
      title="Saved"
      count={agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'}` : ''}
      headerSlot={header}
      tabs={[]}
      tabHint=""
    >
      {agents.length === 0 ? (
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[22px]">
          <div className="text-[14.5px] font-bold">Nothing saved yet.</div>
          <p className="text-muted mt-[5px] mb-0 max-w-[560px] text-[13px] leading-[1.55] text-pretty">
            Saving an agent is a bookmark, not a commitment — it does not hire anything, grant
            anything, or tell the agent you looked.
          </p>
          <button
            type="button"
            onClick={() => router.push(route('/market'))}
            className="bg-ink-app hover:bg-orange-app mt-[16px] h-[38px] rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors"
          >
            Browse the market
          </button>
        </div>
      ) : (
        <MarketGrid
          agents={agents}
          footnote="Every agent here is tested by AiKi itself. Empty bars mean missing evidence, not bad performance."
        />
      )}
    </PageCard>
  )
}
