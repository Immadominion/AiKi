'use client'

import { useRouter } from 'next/navigation'
import { useSaved } from '@/components/shell/prefs'
import { EvidenceBars } from '@/components/ui/EvidenceBars'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, type AgentRow } from '@/lib/agents'
import { agentHref } from '@/lib/routes'

export function MarketGrid({ agents, footnote }: { agents: AgentRow[]; footnote: string }) {
  const { toggle, isSaved } = useSaved()
  const say = useToast()
  const router = useRouter()

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(268px,1fr))] gap-[14px]">
        {agents.map((m) => (
          <div
            key={m.key}
            className="flex flex-col rounded-[18px] border border-[rgb(26_26_25_/_0.08)] p-4 transition-[box-shadow,border-color] hover:border-[rgb(26_26_25_/_0.16)] hover:shadow-[0_12px_30px_-14px_rgb(26_26_25_/_0.2)]"
          >
            <div className="flex items-start gap-[11px]">
              <span
                className="flex size-[42px] flex-none items-center justify-center rounded-[13px] text-base font-extrabold text-white"
                style={{ background: AGENT_BG[m.key] }}
              >
                {m.initial}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15.5px] font-bold tracking-[-0.012em]">{m.name}</span>
                <span className="text-muted mt-[2px] block text-[12.5px]">{m.works}</span>
              </span>
              <button
                type="button"
                title="Save"
                onClick={() => {
                  const on = !isSaved(m.key)
                  toggle(m.key)
                  say(on ? `${m.name} saved.` : `${m.name} removed from saved.`)
                }}
                className="size-[30px] flex-none rounded-[10px] border-0 bg-[rgb(26_26_25_/_0.055)] text-[12px] hover:bg-[rgb(26_26_25_/_0.09)]"
              >
                {isSaved(m.key) ? '♥' : '♡'}
              </button>
            </div>

            <p className="mt-[13px] mb-0 text-[13px] leading-[1.5] text-pretty text-[#57574F]">
              {m.blurb}
            </p>

            <div className="min-h-[14px] flex-1" />

            <div className="mt-[14px] flex items-center gap-[9px] border-t border-[rgb(26_26_25_/_0.07)] pt-[13px]">
              <EvidenceBars filled={m.bars} label={m.evidence} tone={m.evidenceTone} height={16} />
              <div className="flex-1" />
              <span className="flex-none text-[14px] font-extrabold tabular-nums">{m.price}</span>
            </div>

            <button
              type="button"
              onClick={() => router.push(agentHref(m.key))}
              className="bg-ink-app hover:bg-orange-app mt-3 h-[38px] rounded-xl border-0 text-[13.5px] font-bold text-white transition-colors"
            >
              View agent
            </button>
          </div>
        ))}
      </div>
      <p className="text-muted mt-4 mb-0 max-w-[680px] text-[12.5px] leading-[1.5] text-pretty">
        {footnote}
      </p>
    </>
  )
}
