'use client'

import type { LivenessState } from '@aiki/contracts'
import { LIVENESS_DETAIL, LIVENESS_LABEL } from '@/components/ui/LivenessBadge'

/**
 * The sweep. Real numbers, from our own prober, not estimates.
 *
 * 400 agents drawn across 126 distinct 1,000-id blocks of the canonical BSC
 * ERC-8004 registry, August 2026. Spread across blocks rather than taken from a
 * few pages, because a registry dominated by bulk minting returns near-identical
 * neighbours — a few big pages is cluster sampling wearing the costume of a
 * random sample, and any percentage taken from it is falsely precise.
 */
const SWEEP: { state: LivenessState; n: number }[] = [
  { state: 'DECLARED_ONLY', n: 243 },
  { state: 'IMPOSTOR_STATIC', n: 133 },
  { state: 'PLACEHOLDER_URL', n: 22 },
  { state: 'DEGRADED', n: 2 },
  { state: 'LIVE', n: 0 },
]
const TOTAL = 400

const RULES = [
  {
    id: 'D0',
    name: 'Nothing to call',
    what: 'The registration file declares no network endpoint at all, or the endpoint refuses every connection.',
    why: 'Six in ten agents on BNB Chain stop here. They registered a name and never published anything to talk to.',
  },
  {
    id: 'D1',
    name: 'Same answer every time',
    what: 'We ask three times: once properly, once with a nonsense id, once with a non-numeric id. Then we hash each response. Identical hashes mean the endpoint is not reading the question.',
    why: 'A third of the registry does this. Every explorer that checks for HTTP 200 shows these agents as healthy. They are a page, not an agent.',
  },
  {
    id: 'D2',
    name: 'The address is not real',
    what: 'localhost, 127.0.0.1, example.com, 0.0.0.0 and their relatives.',
    why: 'Registered from a developer machine and never updated.',
  },
  {
    id: 'D3',
    name: 'Not reachable over a network',
    what: 'The declared transport is stdio, a local pipe rather than an address anyone else can call.',
    why: 'Perfectly valid MCP. Just not something you can hire from here.',
  },
  {
    id: 'D4',
    name: 'Resolving it cost nothing',
    what: 'The registration file is a data: URI, so it resolves without a single network call.',
    why: 'Not a fault, but not evidence either. Resolving it proves nothing about whether anyone is home.',
  },
  {
    id: 'D5',
    name: 'It answered properly',
    what: 'A real capability handshake: it parsed, it responded in the shape it promised, and it responded differently to different inputs.',
    why: 'This is the only path to Answering. Everything else is a way of failing.',
  },
  {
    id: 'D8',
    name: 'The domain agrees',
    what: 'We fetch /.well-known/agent-registration.json from the endpoint’s own origin and check it names this registry and this token.',
    why: 'Around 0.04% of agents on BNB Chain serve one. Its absence is normal; its presence is the strongest identity signal available.',
  },
  {
    id: 'D10',
    name: 'Many agents, one endpoint',
    what: 'The same exact URL is declared by other identities in the registry.',
    why: 'A URL shared by dozens of identities cannot be agent-specific. D1 cannot catch this on its own, because a URL with no identifier in it has nothing to vary.',
  },
]

const CLASSES = [
  {
    cls: 'A',
    title: 'On-chain, cryptographic',
    body: 'Transactions, signatures, registry state. Strongest by construction, and still not automatically valuable. every piece of ERC-8004 feedback we have seen on BNB Chain carries no payment proof, and moving an agent past a trust threshold costs about $0.0042. We ingest it and weight it near zero.',
  },
  {
    cls: 'B',
    title: 'We watched it ourselves',
    body: 'Our probes and benchmark runs. The only class we fully control, and the one the proof score is mostly built from.',
  },
  {
    cls: 'C',
    title: 'Someone independent attested',
    body: 'A third party we did not pay and do not control. Rare.',
  },
  {
    cls: 'D',
    title: 'Someone said so',
    body: 'Self-reported uptime, marketing copy, registry metadata. Recorded, shown, and never allowed to move a score on its own.',
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
 * The evidence layer, as a docs article.
 *
 * Lives inside the docs rather than as a page of its own, because it is the
 * flagship answer to "why should I believe any of this" and every other doc
 * eventually points back at it.
 */
export function HowWeTestBody() {
  return (
    <>
      <Section
        title="What the registry actually contains"
        note="400 agents drawn across 126 separate blocks of the BNB Chain ERC-8004 registry, August 2026. Spread across blocks rather than taken from a few pages: a registry dominated by bulk minting returns near-identical neighbours, so a few big pages is cluster sampling in the costume of a random sample."
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[16px]">
          {SWEEP.map((r) => (
            <div key={r.state} className="mb-[14px] last:mb-0">
              <div className="flex items-baseline gap-[9px]">
                <span className="text-[13.5px] font-semibold">{LIVENESS_LABEL[r.state]}</span>
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
                {LIVENESS_DETAIL[r.state]}
              </div>
            </div>
          ))}
        </div>

        <div className="bg-warn-bg mt-3 flex items-start gap-[10px] rounded-[15px] px-[14px] py-[12px]">
          <span className="bg-warn mt-px flex size-[19px] flex-none items-center justify-center rounded-[7px] text-[11px] font-extrabold text-white">
            !
          </span>
          <span className="text-[12.5px] leading-[1.55] text-pretty text-[#6B5A34]">
            <b className="font-bold">Not one agent in that sample was fully live.</b> That is the
            honest headline, it is worse than anything published about this registry, and it is why
            AiKi tests rather than lists. Two were reachable but slow. The rest could not be called
            at all, or answered without reading the question.
          </span>
        </div>

        <p className="text-muted mt-3 mb-0 max-w-[680px] text-[12.5px] leading-[1.55] text-pretty">
          These are the numbers from that one fixed draw, and they do not move. The{' '}
          <a className="font-semibold underline underline-offset-2" href="/registry">
            registry page
          </a>{' '}
          shows the running totals from the continuous sweep, and it does find live agents. The two
          disagree because they are different populations: this sample was stratified to be
          representative, while the sweep works through whatever is due to be re-checked. Take the
          percentages from here and the current counts from there, and do not mix them.
        </p>
      </Section>

      <Section
        title="How we decide"
        note="Every agent runs through the same rules in the same order. A verdict always names the rule that produced it, so a claim about an agent can be traced to the check behind it, and disputed."
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
        title="Why a score is never a raw percentage"
        note="Four successes out of four and 171 out of 174 are both “100%” and “98%” to a naive ratio, and the first tells you almost nothing. We publish the lower end of a Wilson interval instead, so a thin sample cannot look like a strong one."
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          {[
            {
              label: '4 of 4 checks passed',
              naive: '100%',
              ours: '51',
              note: 'Four checks cannot tell a good agent from a lucky one.',
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
              note: 'Enough evidence to print two digits and mean them.',
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
          The number of digits we print is itself a claim about how much we know. Printing 95.3 on a
          handful of observations is a lie told in typography, so precision is clamped to confidence
          and, below a floor, we print no number at all.
        </p>
      </Section>

      <Section
        title="What each kind of evidence is worth"
        note="Class is not the same as value. On-chain evidence is the strongest by construction and can still be close to worthless in practice. We say which, rather than letting the label do the arguing."
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
              'Telling apart two agents differing by half a Sharpe ratio needs decades of data. Where the ranges overlap we say so instead of ranking.',
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
