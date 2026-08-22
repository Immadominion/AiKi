import type { EnforcementTier, LivenessState, Measure, Money } from '@aiki/contracts'
import { AgentAvatar } from '@/components/primitives/AgentAvatar'
import { EnforcementCell } from '@/components/primitives/EnforcementCell'
import { EvidenceStrip } from '@/components/primitives/EvidenceStrip'
import { LivenessBadge } from '@/components/primitives/LivenessBadge'
import { MoneyValue } from '@/components/primitives/MoneyValue'
import { ProofScore } from '@/components/primitives/ProofScore'
import { SpendMeter } from '@/components/primitives/SpendMeter'

/**
 * Component lab.
 *
 * Every primitive in every state, including the ugly ones — thin evidence, impostor
 * endpoints, unverified claims, near-exhausted caps. The design reference only ever
 * draws healthy agents, so this is where the states that actually dominate our data
 * get looked at.
 *
 * Not linked from the app. Dev surface only.
 */

const U = (amount: string): Money => ({ amount, asset: 'U', decimals: 18 })

const measure = (successes: number, trials: number): Measure => {
  const z = 1.96
  const p = trials ? successes / trials : 0
  const d = 1 + (z * z) / (trials || 1)
  const c = p + (z * z) / (2 * (trials || 1))
  const m = z * Math.sqrt((p * (1 - p)) / (trials || 1) + (z * z) / (4 * (trials || 1) ** 2))
  const lo = trials ? (c - m) / d : 0
  const hi = trials ? Math.min(1, (c + m) / d) : 1
  return {
    value: Math.round(lo * 1000) / 10,
    confidence: trials ? Math.max(0, 1 - (hi - lo)) : 0,
    interval: [Math.round(lo * 1000) / 10, Math.round(hi * 1000) / 10],
    sampleSize: trials,
    method: `wilson-lb;z=${z}`,
    provenance: {
      source: 'aiki:prober',
      method: 'capability-probe/v2',
      observedAt: new Date().toISOString(),
      evidenceClass: 'B',
    },
  }
}

const ALL_STATES: LivenessState[] = [
  'LIVE',
  'DEGRADED',
  'IMPOSTOR_STATIC',
  'PLACEHOLDER_URL',
  'NOT_REMOTE',
  'UNREACHABLE',
  'DECLARED_ONLY',
  'UNPROBED',
]

const TIERS: EnforcementTier[] = ['T0', 'T1', 'T2', 'T3']

export default function Lab() {
  return (
    <main className="mx-auto max-w-5xl px-8 py-14">
      <h1 className="text-[32px] font-extrabold tracking-tight">Component lab</h1>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-grey-500">
        Every primitive in every state. The design reference only draws healthy agents; our own
        sweep found zero live and a third impostors, so these are the states that actually matter.
      </p>

      <Section title="Liveness — seven states, plain language">
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {ALL_STATES.map((s) => (
            <div key={s} className="rounded-2xl bg-surface p-4 edge-observed">
              <LivenessBadge state={s} withBlurb />
              <code className="mt-2.5 block text-[10px] text-grey-300">{s}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Proof score — precision clamps to confidence">
        <div className="grid gap-6 sm:grid-cols-3">
          <Card label="104 observations · high confidence">
            <ProofScore measure={measure(89, 104)} size="lg" />
          </Card>
          <Card label="A perfect record, from 4 tries">
            <ProofScore measure={measure(4, 4)} size="lg" />
          </Card>
          <Card label="Below threshold — withheld">
            <ProofScore measure={measure(1, 1)} size="lg" />
          </Card>
        </div>
        <p className="mt-4 text-[12.5px] leading-relaxed text-grey-500">
          The middle one is the point: a flawless 4-for-4 scores <em>below</em> a 104-sample 89,
          because the interval is enormous. No second number is shown — confidence changes how the
          value is drawn, never sits beside it.
        </p>
      </Section>

      <Section title="Evidence — countable, fixed length">
        <div className="grid gap-6 sm:grid-cols-3">
          <Card label="Mature">
            <EvidenceStrip observed={20} />
          </Card>
          <Card label="Building">
            <EvidenceStrip observed={7} />
          </Card>
          <Card label="Nothing yet">
            <EvidenceStrip observed={0} />
          </Card>
        </div>
      </Section>

      <Section title="Enforcement — strong is quiet, weak is loud">
        <div className="grid gap-5 sm:grid-cols-2">
          {TIERS.map((t) => (
            <div key={t} className="rounded-2xl bg-surface p-4 edge-observed">
              <EnforcementCell info={{ tier: t, enforcedBy: 'demo', verified: true }} showPlain />
            </div>
          ))}
          <div className="rounded-2xl bg-surface p-4 edge-observed sm:col-span-2">
            <EnforcementCell
              info={{
                tier: 'T0',
                enforcedBy: 'altana:KeyStore',
                verified: false,
                caveat: 'The audit covers the registry, not the contract that enforces the cap.',
              }}
              showPlain
            />
          </div>
        </div>
      </Section>

      <Section title="Spend — renewing and lifetime are different objects">
        <div className="grid gap-6 sm:grid-cols-2">
          <Card label="Lifetime cap">
            <SpendMeter
              spent={U('18000000000000000000')}
              cap={U('250000000000000000000')}
              period="total"
            />
          </Card>
          <Card label="Renewing, nearly exhausted">
            <SpendMeter
              spent={U('108000000000000000000')}
              cap={U('120000000000000000000')}
              period="per_month"
              resetsAt="Mon 1 Sep"
            />
          </Card>
        </div>
      </Section>

      <Section title="Money — decimals always from the payload">
        <div className="flex flex-wrap items-center gap-6 text-[15px]">
          <MoneyValue value={U('131500000000000000')} />
          <MoneyValue value={U('250000000000000000000')} />
          <MoneyValue value={{ amount: '5500000000000000', asset: 'BNB', decimals: 18 }} />
        </div>
        <p className="mt-3 text-[12.5px] text-grey-500">
          USDT on BSC is 18 decimals, not 6. There is no default — omitting it is a 10<sup>12</sup>{' '}
          error.
        </p>
      </Section>

      <Section title="Avatars — deterministic, purple lives only here">
        <div className="flex flex-wrap items-center gap-4">
          {['Guardian', 'RangePilot', 'Gridly', 'Yield Allocator', 'Agent #270263'].map((n) => (
            <div key={n} className="flex items-center gap-2.5">
              <AgentAvatar name={n} glow />
              <span className="text-[13px] font-semibold">{n}</span>
            </div>
          ))}
        </div>
      </Section>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-14">
      <h2 className="mb-5 text-[11px] font-bold uppercase tracking-[0.18em] text-grey-400">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-surface p-5 edge-observed">
      {children}
      <div className="mt-3 text-[11px] font-medium text-grey-400">{label}</div>
    </div>
  )
}
