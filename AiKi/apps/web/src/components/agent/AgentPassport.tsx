'use client'

import { useRouter } from 'next/navigation'
import { EvidenceList, Fact, RiskList } from '@/components/agent/Callouts'
import { ComponentRows } from '@/components/agent/ComponentRows'
import { EnforcementList } from '@/components/agent/EnforcementList'
import { ScoreBlock } from '@/components/agent/ScoreBlock'
import { PageCard } from '@/components/shell/PageCard'
import { EvidenceBars } from '@/components/ui/EvidenceBars'
import { LIVENESS_DETAIL, LivenessBadge } from '@/components/ui/LivenessBadge'
import { AGENT_BG, AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { type Counts, DETAILS } from '@/lib/detail'
import { shortAddress } from '@/lib/format'
import { aikiProbe, measureFrom } from '@/lib/measure'
import { hireHref, route } from '@/lib/routes'

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

const Section = ({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) => (
  <section className="mb-6 last:mb-0">
    <h2 className="mb-[3px] text-[14.5px] font-bold">{title}</h2>
    {note ? (
      <p className="text-muted mt-0 mb-[11px] text-[12.5px] leading-[1.5] text-pretty">{note}</p>
    ) : (
      <div className="h-[11px]" />
    )}
    {children}
  </section>
)

export function AgentPassport({ agentKey }: { agentKey: AgentKey }) {
  const row = AGENT_BY_KEY[agentKey]
  const d = DETAILS[agentKey]
  const router = useRouter()

  const m = (c: Counts) => measureFrom(c[0], c[1], aikiProbe(d.liveness.lastProbeAt))
  const overall = m(d.checks)

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <span
        className="flex size-[52px] flex-none items-center justify-center rounded-[16px] text-[20px] font-extrabold text-white"
        style={{ background: AGENT_BG[agentKey] }}
      >
        {row.initial}
      </span>
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="flex items-center gap-[10px]">
          <span className="text-[19px] font-extrabold tracking-[-0.02em]">{row.name}</span>
          <LivenessBadge state={d.liveness.state} />
        </div>
        <p className="text-muted mt-[3px] mb-0 max-w-[560px] text-[13px] leading-[1.45] text-pretty">
          {d.tagline}
        </p>
      </div>
      <div className="flex w-full flex-none items-center justify-between gap-[14px] sm:w-auto sm:justify-end">
        <span className="text-right">
          <span className="block text-[15px] font-extrabold tabular-nums">{row.price}</span>
          <span className="text-muted mt-px block text-[11.5px] font-medium">
            {d.settlementAsset} · on BNB Chain
          </span>
        </span>
        <button
          type="button"
          onClick={() =>
            router.push(
              route(
                `/compare?agents=${agentKey},${agentKey === 'guardian' ? 'sentinel' : 'guardian'}`,
              ),
            )
          }
          className="text-ink-app h-[38px] rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-4 text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
        >
          Compare
        </button>
        <button
          type="button"
          onClick={() => router.push(hireHref(agentKey))}
          className="bg-ink-app hover:bg-orange-app h-[38px] rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors"
        >
          Hire {row.name}
        </button>
      </div>
    </div>
  )

  const evidence = (
    <>
      <div className="grid gap-[14px] lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <ScoreBlock
          measure={overall}
          label="Proof score"
          note="The lower end of what the evidence supports, not the average. A perfect run of four checks scores near 51, because four checks cannot tell a good agent from a lucky one."
        />
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          <Fact label="Right now">{LIVENESS_DETAIL[d.liveness.state]}</Fact>
          <Fact label="Last checked">
            {new Date(d.liveness.lastProbeAt).toLocaleString('en-GB', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </Fact>
          <Fact label="Regions probed">
            {d.liveness.regionsProbed}, so a network fault cannot be mistaken for a dead agent
          </Fact>
          {d.liveness.p95LatencyMs ? (
            <Fact
              label="Slowest 1 in 20 replies"
              tone={d.liveness.p95LatencyMs > 3000 ? 'warn' : 'plain'}
            >
              {(d.liveness.p95LatencyMs / 1000).toFixed(1)} seconds
            </Fact>
          ) : null}
          <Fact label="Charged as">{d.priceModel}</Fact>
        </div>
      </div>

      <div className="h-6" />

      <Section
        title="What the score is made of"
        note="Each part carries its own evidence. A strong total built on one thin part is visible here rather than hidden inside an average."
      >
        <ComponentRows
          rows={[
            { label: 'Answers when asked', measure: m(d.components.liveness) },
            { label: 'Finishes what it starts', measure: m(d.components.executionReliability) },
            { label: 'Result was worth it', measure: m(d.components.outcomeQuality) },
            { label: 'What others report', measure: m(d.components.reputation) },
            { label: 'Stayed inside its limits', measure: m(d.components.safety) },
          ]}
        />
      </Section>

      <Section title="What we hold" note="Kinds of evidence, and what each is worth.">
        <EvidenceList items={d.evidence} />
      </Section>
    </>
  )

  const canDo = (
    <>
      <Section
        title="What it can do"
        note="Each capability lists the permissions it needs. You grant these one by one when you hire, and never more than what is listed here."
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          {d.capabilities.map((c, i) => (
            <div
              key={c.name}
              className={`px-4 py-[14px] ${i > 0 ? 'border-t border-[rgb(26_26_25_/_0.06)]' : ''}`}
            >
              <div className="text-[13.5px] font-bold">{c.name}</div>
              <div className="text-muted mt-[3px] text-[12.5px] leading-[1.5] text-pretty">
                {c.does}
              </div>
              <div className="mt-[9px] flex flex-wrap gap-[6px]">
                {c.permissions.map((p) => (
                  <span
                    key={p}
                    className="text-muted rounded-full bg-[rgb(26_26_25_/_0.05)] px-[9px] py-[4px] font-mono text-[11px] font-semibold"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Where its limits are held"
        note="Not whether a limit exists, because every agent claims limits. Where the limit actually lives, and what would have to break for it to fail."
      >
        <EnforcementList lines={d.enforcement} />
      </Section>
    </>
  )

  const identity = (
    <Section
      title="Identity"
      note="What the registry says, and how much of it is proven rather than asserted."
    >
      <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
        <Fact label="Registry">ERC-8004 IdentityRegistry on BNB Chain · token {d.tokenId}</Fact>
        <Fact label="Owner">{shortAddress(d.owner)}</Fact>
        <Fact label="Owner proved the wallet" tone={d.agentWalletProven ? 'plain' : 'warn'}>
          {d.agentWalletProven
            ? 'Yes. Signed, and checked by us. This is the only field ERC-8004 proves cryptographically.'
            : 'No. The registry names a wallet; nothing proves the owner controls it.'}
        </Fact>
        <Fact label="Domain links back" tone={d.reciprocalProofVerified ? 'plain' : 'warn'}>
          {d.reciprocalProofVerified
            ? 'Yes. The endpoint serves a matching /.well-known file.'
            : 'No. Around 0.04% of agents on BNB Chain do, so this is normal rather than damning. It just means the domain is not evidence.'}
        </Fact>
        <Fact label="Registration file">
          {d.uriScheme === 'data'
            ? 'Stored inline as a data: URI, so resolving it costs no network call and proves nothing.'
            : `Served over ${d.uriScheme}, and it resolved when we asked.`}
        </Fact>
        <Fact label="Trust models declared" tone={d.supportedTrust.length ? 'plain' : 'warn'}>
          {d.supportedTrust.length
            ? d.supportedTrust.join(', ')
            : 'None. The registry entry is discovery only, and makes no trust claim at all.'}
        </Fact>
        <Fact label="Changed hands" tone={d.ownershipTransfers ? 'warn' : 'plain'}>
          {d.ownershipTransfers === 0
            ? 'Never. Evidence covers one continuous owner.'
            : `${d.ownershipTransfers} time${d.ownershipTransfers > 1 ? 's' : ''}. Evidence from before the transfer is kept separately and does not count toward the score.`}
        </Fact>
        <Fact label="Registered">{day(d.registeredAt)}</Fact>
      </div>
    </Section>
  )

  const risks = (
    <Section
      title="What could go wrong"
      note="Written out rather than scored, because a number here would let you skip reading it."
    >
      <RiskList risks={d.risks} />
    </Section>
  )

  return (
    <PageCard
      title={row.name}
      count={row.works}
      back={{ href: '/explore', label: 'Explore' }}
      headerSlot={header}
      tabs={['Evidence', 'What it can do', 'Identity', 'Risks']}
      tabHint={
        <span key="hint">
          <EvidenceBars
            filled={row.bars}
            label={row.evidence}
            tone={row.evidenceTone}
            height={14}
          />
        </span>
      }
      banner={
        d.liveness.state === 'DEGRADED'
          ? {
              title: 'This one is slow.',
              body: d.liveness.detail,
              cta: 'How we test',
              onAction: () => router.push(route('/docs/how-we-test')),
            }
          : undefined
      }
      panels={[evidence, canDo, identity, risks]}
    />
  )
}
