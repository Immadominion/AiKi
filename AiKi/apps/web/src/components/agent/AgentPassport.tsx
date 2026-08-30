'use client'

import type { Measure } from '@aiki/contracts'
import { BarChart3Icon, Clock3Icon, GaugeIcon, WalletCardsIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { AgentCredentialCard } from '@/components/agent/AgentCredentialCard'
import { AgentInspectionWorkbench } from '@/components/agent/AgentInspectionWorkbench'
import { AgentOperationFlow } from '@/components/agent/AgentOperationFlow'
import { AgentProfileShell } from '@/components/agent/AgentProfileShell'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { type Counts, DETAILS } from '@/lib/detail'
import { formatScore } from '@/lib/format'
import { aikiProbe, measureFrom } from '@/lib/measure'
import { hireHref, route } from '@/lib/routes'

function Metric({
  label,
  value,
  note,
  icon,
}: {
  label: string
  value: string
  note: string
  icon: React.ReactNode
}) {
  return (
    <div className="min-w-0 border-l border-[rgb(26_26_25_/_0.08)] px-2.5 py-2 first:border-l-0 first:pl-0 sm:px-3 sm:py-2.5">
      <small className="text-faint flex items-center gap-1.5 text-[6.5px] font-bold tracking-[0.08em] uppercase">
        {icon}
        {label}
      </small>
      <b className="mt-1 block truncate text-[14px] tracking-[-0.03em] tabular-nums">{value}</b>
      <span className="text-muted mt-0.5 block truncate text-[7px] font-medium">{note}</span>
    </div>
  )
}

export function AgentPassport({ agentKey }: { agentKey: AgentKey }) {
  const row = AGENT_BY_KEY[agentKey]
  const detail = DETAILS[agentKey]
  const router = useRouter()
  const say = useToast()
  const [saved, setSaved] = useState(false)

  const measure = (counts: Counts): Measure =>
    measureFrom(counts[0], counts[1], aikiProbe(detail.liveness.lastProbeAt))
  const overall = measure(detail.checks)
  const proof = formatScore(overall)
  const components = [
    { label: 'Answers when asked', measure: measure(detail.components.liveness) },
    {
      label: 'Finishes what it starts',
      measure: measure(detail.components.executionReliability),
    },
    { label: 'Result was worth it', measure: measure(detail.components.outcomeQuality) },
    { label: 'What others report', measure: measure(detail.components.reputation) },
    { label: 'Stayed inside limits', measure: measure(detail.components.safety) },
  ]

  const onCompare = () =>
    router.push(
      route(`/compare?agents=${agentKey},${agentKey === 'guardian' ? 'sentinel' : 'guardian'}`),
    )
  const onSave = () => {
    setSaved(true)
    say(`${row.name} saved.`)
  }

  return (
    <AgentProfileShell
      tokenId={detail.tokenId}
      onSave={onSave}
      onCompare={onCompare}
      saved={saved}
      passport={
        <AgentCredentialCard
          row={row}
          detail={detail}
          overall={overall}
          onHire={() => router.push(hireHref(agentKey))}
          onSave={onSave}
          onCompare={onCompare}
          saved={saved}
        />
      }
    >
      <div className="min-w-0 self-start">
        <header className="px-0.5 pt-0.5 pb-3">
          <div className="text-orange-app mb-1.5 text-[8px] font-extrabold tracking-[0.15em] uppercase">
            {row.works} · Agent profile
          </div>
          <h1 className="max-w-[850px] text-[clamp(25px,2.35vw,34px)] leading-[1.04] font-extrabold tracking-[-0.055em] text-pretty">
            {detail.tagline}
          </h1>
          <p className="text-body mt-1.5 mb-0 max-w-[780px] text-[10px] leading-[1.5] text-pretty">
            It can act only inside the permissions and limits you approve. Every trust claim stays
            attached to the evidence or enforcement source behind it. This is an example profile,
            not a measured registry entry.
          </p>
        </header>

        <section
          aria-label="Agent decision summary"
          className="mb-3 grid grid-cols-2 border-y border-[rgb(26_26_25_/_0.14)] sm:grid-cols-4"
        >
          <Metric
            label="Proof"
            value={`${proof.text}${proof.withheld ? '' : ' / 100'}`}
            note={`supported by ${overall.sampleSize.toLocaleString()} checks`}
            icon={<BarChart3Icon aria-hidden size={10} />}
          />
          <Metric
            label="Observations"
            value={`${detail.checks[0].toLocaleString()} / ${detail.checks[1].toLocaleString()}`}
            note="successful direct probes"
            icon={<GaugeIcon aria-hidden size={10} />}
          />
          <Metric
            label="Reply time"
            value={
              detail.liveness.p95LatencyMs
                ? `${(detail.liveness.p95LatencyMs / 1000).toFixed(1)} sec`
                : 'Not measured'
            }
            note="slowest 1 in 20 replies"
            icon={<Clock3Icon aria-hidden size={10} />}
          />
          <Metric
            label="Price"
            value={detail.price}
            note={detail.priceModel}
            icon={<WalletCardsIcon aria-hidden size={10} />}
          />
        </section>

        <AgentOperationFlow detail={detail} />
        <AgentInspectionWorkbench
          row={row}
          detail={detail}
          overall={overall}
          components={components}
        />
      </div>
    </AgentProfileShell>
  )
}
