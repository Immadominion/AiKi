'use client'

import type { LivenessState } from '@aiki/contracts'
import { LIVENESS_DETAIL, LIVENESS_LABEL } from '@/components/ui/LivenessBadge'

/**
 * Counts recorded in the 20 August 2026 first-party sweep report.
 *
 * 400 agents drawn across 126 distinct 1,000-id blocks of the canonical BSC
 * ERC-8004 registry. Spreading the draw reduces concentration in neighbouring
 * registrations; it does not establish registry-wide prevalence. The raw sweep
 * artifact referenced by the report was missing from the checkout on
 * 8 September 2026, so the report is not a complete reproducibility package.
 */
const SWEEP: { state: LivenessState; n: number }[] = [
  { state: 'DECLARED_ONLY', n: 243 },
  { state: 'IMPOSTOR_STATIC', n: 133 },
  { state: 'PLACEHOLDER_URL', n: 22 },
  { state: 'DEGRADED', n: 2 },
  { state: 'LIVE', n: 0 },
]
const TOTAL = 400

// The report's classifications are narrower than the current shared UI labels.
const SNAPSHOT_LABEL: Partial<Record<LivenessState, string>> = {
  DEGRADED: 'Reachable, not yet proven',
  IMPOSTOR_STATIC: 'Static or shared response',
  PLACEHOLDER_URL: 'Unresolved address template',
}
const SNAPSHOT_DETAIL: Partial<Record<LivenessState, string>> = {
  DEGRADED: 'The endpoint responded, but the sweep did not establish agent-specific behavior.',
  IMPOSTOR_STATIC:
    'D1 found identical responses to varied inputs, or D10 found the same URL under different identities.',
  PLACEHOLDER_URL: 'The declared address contained an unexpanded template such as {agentId}.',
}

const RULES = [
  {
    id: 'D0',
    name: 'Nothing to call',
    what: 'The registration file declares no network endpoint at all, or the endpoint refuses every connection.',
    why: 'Six in ten registrations in the 20 August sample declared no endpoint. That describes this sample, not every agent on BNB Chain.',
  },
  {
    id: 'D1',
    name: 'Same answer every time',
    what: 'We ask three times: once properly, once with a nonsense id, once with a non-numeric id. Then we hash each response. Identical hashes do not establish agent-specific behavior.',
    why: 'About a third of the sample was flagged by D1 or D10. An HTTP 200 response alone would miss these distinctions; it does not prove that an agent can do the job.',
  },
  {
    id: 'D2',
    name: 'The address is not real',
    what: 'localhost, 127.0.0.1, example.com, 0.0.0.0 and their relatives.',
    why: 'A placeholder or local address does not identify a publicly callable service.',
  },
  {
    id: 'D3',
    name: 'Not reachable over a network',
    what: 'The declared transport is stdio, a local pipe rather than an address anyone else can call.',
    why: 'A valid local MCP transport is not a remotely callable service. This check does not assess other ways the provider might offer work.',
  },
  {
    id: 'D4',
    name: 'Resolving it cost nothing',
    what: 'The registration file is a data: URI, so it resolves without a single network call.',
    why: 'This provides registration metadata, not evidence that the declared service is running.',
  },
  {
    id: 'D5',
    name: 'It answered properly',
    what: 'A real capability handshake: it parsed, it responded in the shape it promised, and it responded differently to different inputs.',
    why: 'Passing this check supports an Answering verdict. It is not a guarantee of job quality, safety or successful delivery.',
  },
  {
    id: 'D8',
    name: 'The domain agrees',
    what: 'We fetch /.well-known/agent-registration.json from the endpoint’s own origin and check it names this registry and this token.',
    why: 'An August 8004scan snapshot reported around 0.04% reciprocal verification across its broader registry dataset, not BNB alone. A matching record links the domain and registration; it does not establish capability or safety.',
  },
  {
    id: 'D10',
    name: 'Many agents, one endpoint',
    what: 'The same exact URL is declared by other identities in the registry.',
    why: 'A shared URL alone does not establish which agent is answering, so this rule flags it. D1 cannot vary a URL identifier when none is present; a provider may need another way to demonstrate agent-specific behavior.',
  },
]

const CLASSES = [
  {
    cls: 'A',
    title: 'On-chain, cryptographic',
    body: 'Transactions, signatures and registry state can verify particular facts, not the quality of a job. The 2026 study Can Trustless Agents Be Trusted? reported no payment proof or task linkage in its BSC feedback dataset and a modeled median cost of $0.0042 to cross its trust threshold. Those are study findings, not current prices or results from this sweep.',
  },
  {
    cls: 'B',
    title: 'We watched it ourselves',
    body: 'Checks AiKi runs itself. A result describes what was observed under those conditions. Our own method can have faults, and these checks are not independent attestations.',
  },
  {
    cls: 'C',
    title: 'Someone independent attested',
    body: 'A third-party attestation. Its value depends on who made it, what they checked and whether they are independent of the provider.',
  },
  {
    cls: 'D',
    title: 'Someone said so',
    body: 'Self-reported uptime, descriptions and registry metadata. Useful for understanding an offer, but a claim alone does not prove that the provider can deliver it.',
  },
]

const Bar = ({ n }: { n: number }) => (
  <span className="block h-[8px] overflow-hidden rounded-full bg-[rgb(26_26_25_/_0.06)]">
    <span
      className="bg-orange-app block h-full rounded-full"
      style={{ width: `${Math.max((n / TOTAL) * 100, n ? 1 : 0)}%` }}
    />
  </span>
)

const Section = ({
  title,
  note,
  children,
}: {
  title: string
  note: string
  children: React.ReactNode
}) => (
  <section className="mb-[26px] last:mb-0">
    <h2 className="mb-[3px] text-[15px] font-bold">{title}</h2>
    <p className="text-muted mt-0 mb-[13px] max-w-[680px] text-[12.5px] leading-[1.55] text-pretty">
      {note}
    </p>
    {children}
  </section>
)

/**
 * Documentation for endpoint checks that support marketplace discovery.
 * These checks are separate from hiring, delivery, buyer review and payment.
 */
export function HowWeTestBody() {
  return (
    <>
      <Section
        title="What one registry sample showed"
        note="On 20 August 2026, AiKi's sweep report recorded checks on 400 registrations across 126 separate 1,000-id blocks of the BNB Chain ERC-8004 registry. These counts describe that sample and date. They are not current totals or a measure of every provider available for hire."
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[16px]">
          {SWEEP.map((r) => (
            <div key={r.state} className="mb-[14px] last:mb-0">
              <div className="flex items-baseline gap-[9px]">
                <span className="text-[13.5px] font-semibold">
                  {SNAPSHOT_LABEL[r.state] ?? LIVENESS_LABEL[r.state]}
                </span>
                <div className="flex-1" />
                <span className="text-[13.5px] font-bold tabular-nums">{r.n}</span>
                <span className="text-muted w-[52px] text-right text-[12.5px] font-semibold tabular-nums">
                  {((r.n / TOTAL) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="mt-[7px]">
                <Bar n={r.n} />
              </div>
              <div className="text-muted mt-[6px] text-[12px] leading-[1.45] text-pretty">
                {SNAPSHOT_DETAIL[r.state] ?? LIVENESS_DETAIL[r.state]}
              </div>
            </div>
          ))}
        </div>

        <div className="bg-warn-bg mt-3 flex items-start gap-[10px] rounded-[15px] px-[14px] py-[12px]">
          <span className="bg-warn mt-px flex size-[19px] flex-none items-center justify-center rounded-[7px] text-[11px] font-extrabold text-white">
            !
          </span>
          <span className="text-[12.5px] leading-[1.55] text-pretty text-[#6B5A34]">
            <b className="font-bold">No sampled endpoint passed the full check.</b> Two were
            reachable but remained unproven. This is a result under the sweep's rules, not a verdict
            on every agent or hiring path. Endpoint checks help people choose an available provider;
            completed work and buyer review answer different questions.
          </span>
        </div>

        <p className="text-muted mt-3 mb-0 max-w-[680px] text-[12.5px] leading-[1.55] text-pretty">
          These historical counts are separate from the{' '}
          <a className="font-semibold underline underline-offset-2" href="/registry">
            registry page
          </a>{' '}
          and its ongoing checks. Different dates and selections can produce different results, so
          do not combine their totals. As of 8 September 2026, the raw file referenced by this
          historical sweep report was missing from the retained research files. These are the
          report's recorded figures; independent reproduction needs that source file.
        </p>
      </Section>

      <Section
        title="How endpoint checks work"
        note="These rules assess declared agent endpoints, not human providers or the whole marketplace journey. A verdict should identify the check behind it so the result can be inspected and corrected."
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          {RULES.map((r, i) => (
            <div
              key={r.id}
              className={`flex items-start gap-[13px] px-4 py-[14px] ${i > 0 ? 'border-t border-[rgb(26_26_25_/_0.06)]' : ''}`}
            >
              <span className="text-muted flex size-[32px] flex-none items-center justify-center rounded-[10px] bg-[rgb(26_26_25_/_0.05)] font-mono text-[12px] font-bold">
                {r.id}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-bold">{r.name}</span>
                <span className="text-body mt-[4px] block text-[12.5px] leading-[1.5] text-pretty">
                  {r.what}
                </span>
                <span className="text-muted mt-[5px] block text-[12px] leading-[1.5] text-pretty">
                  {r.why}
                </span>
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Why sample size matters"
        note="Four successes out of four gives 100%; 171 out of 174 gives about 98%. The smaller sample carries more uncertainty. These examples use the lower end of a Wilson interval to show that difference. They describe checks, not a guarantee of future job performance."
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          {[
            {
              label: '4 of 4 checks passed',
              naive: '100%',
              ours: '51',
              note: 'Four successful checks provide limited evidence of reliability.',
            },
            {
              label: '6 of 7 checks passed',
              naive: '86%',
              ours: '≈50',
              note: 'Still thin. The digits are clamped because the range is wide.',
            },
            {
              label: '171 of 174 checks passed',
              naive: '98%',
              ours: '95',
              note: 'More observations narrow the interval under the same test conditions.',
            },
          ].map((r, i) => (
            <div
              key={r.label}
              className={`flex flex-wrap items-center gap-x-[16px] gap-y-[6px] px-4 py-[13px] ${i > 0 ? 'border-t border-[rgb(26_26_25_/_0.06)]' : ''}`}
            >
              <span className="min-w-[190px] flex-1 text-[13.5px] font-semibold">{r.label}</span>
              <span className="text-faint w-[64px] text-right text-[14px] font-semibold tabular-nums line-through">
                {r.naive}
              </span>
              <span className="w-[54px] text-right text-[17px] font-extrabold tabular-nums">
                {r.ours}
              </span>
              <span className="text-muted w-full text-[12px] leading-[1.45] text-pretty">
                {r.note}
              </span>
            </div>
          ))}
        </div>
        <p className="text-muted mt-3 mb-0 max-w-[680px] text-[12.5px] leading-[1.55] text-pretty">
          A number like 95.3 can imply more precision than a small sample supports. Sample size,
          uncertainty and test conditions belong beside a result. A precise-looking score still does
          not establish that a provider can complete your particular job.
        </p>
      </Section>

      <Section
        title="Where evidence comes from"
        note="Source and usefulness are different questions. A transaction can prove that a payment happened without proving that the work was good. Read each source alongside the fact it supports."
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          {CLASSES.map((c, i) => (
            <div
              key={c.cls}
              className={`flex items-start gap-[13px] px-4 py-[14px] ${i > 0 ? 'border-t border-[rgb(26_26_25_/_0.06)]' : ''}`}
            >
              <span className="flex size-[32px] flex-none items-center justify-center rounded-[10px] bg-[rgb(26_26_25_/_0.05)] text-[14px] font-extrabold">
                {c.cls}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-bold">{c.title}</span>
                <span className="text-muted mt-[4px] block text-[12.5px] leading-[1.5] text-pretty">
                  {c.body}
                </span>
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="What we cannot do"
        note="The limits of the method, stated here rather than discovered by you later."
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          {[
            [
              'We cannot replay an agent exactly',
              'Chain state, prices and the clock can be pinned. The agent’s own model sampling is a third-party endpoint and cannot be. Benchmark runs report which parts were pinned.',
            ],
            [
              'We cannot separate close performers',
              'Under the assumptions in our measurement research, separating agents differing by half a Sharpe ratio takes decades of data. Overlapping ranges do not support a confident ranking.',
            ],
            [
              'We cannot enforce what the chain does not hold',
              'Where a limit lives outside a contract we mark it, name who holds it, and say what would have to break.',
            ],
            [
              'Our own probing can be the fault',
              'Firing many parallel requests at one host makes it time out, and recording that as the host’s failure would be both rude and wrong. Probes are serialised per host with a gap between them.',
            ],
          ].map(([title, body], i) => (
            <div
              key={title}
              className={`px-4 py-[13px] ${i > 0 ? 'border-t border-[rgb(26_26_25_/_0.06)]' : ''}`}
            >
              <div className="text-[13.5px] font-bold">{title}</div>
              <div className="text-muted mt-[4px] text-[12.5px] leading-[1.5] text-pretty">
                {body}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}
