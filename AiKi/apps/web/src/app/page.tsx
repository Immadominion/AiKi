import type { LivenessState } from '@aiki/contracts'
import Link from 'next/link'
import { api } from '@/lib/api'
import { pct } from '@/lib/format'

/**
 * The honesty dashboard.
 *
 * This is deliberately the first screen. Every competitor opens with a count of
 * registered agents; we open with what we actually verified — including that
 * almost none of them work. It is the cheapest screen to build and the only one
 * nobody else can copy without doing the measurement.
 */

/** Plain language first. Amina should never need to read an enum. */
const STATE_COPY: Record<
  LivenessState,
  { label: string; blurb: string; tone: 'bad' | 'warn' | 'good' | 'mute' }
> = {
  LIVE: {
    label: 'Working',
    blurb: 'Answered, and answered specifically for this agent',
    tone: 'good',
  },
  DEGRADED: {
    label: 'Unproven',
    blurb: 'Responded, but we could not prove it is agent-specific',
    tone: 'warn',
  },
  IMPOSTOR_STATIC: {
    label: 'Not a real agent',
    blurb: 'Returns identical bytes whatever you ask it — a static page wearing an agent’s name',
    tone: 'bad',
  },
  PLACEHOLDER_URL: {
    label: 'Broken address',
    blurb: 'Published an unfilled {template} as its endpoint',
    tone: 'bad',
  },
  NOT_REMOTE: {
    label: 'Local only',
    blurb: 'Declared, but cannot be called over the network',
    tone: 'warn',
  },
  UNREACHABLE: {
    label: 'No answer',
    blurb: 'Declared an endpoint that never responded',
    tone: 'bad',
  },
  DECLARED_ONLY: {
    label: 'No endpoint',
    blurb: 'Registered on-chain, but offers no service at all',
    tone: 'mute',
  },
  UNPROBED: { label: 'Not yet checked', blurb: 'In the queue', tone: 'mute' },
}

const TONE = {
  bad: 'text-danger',
  warn: 'text-aiki-orange-ink',
  good: 'text-gain',
  mute: 'text-neutral-500',
} as const

export default async function Home() {
  const stats = await api.stats().catch(() => null)

  if (!stats) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-24">
        <h1 className="display">Nothing to show yet.</h1>
        <p className="mt-4 text-neutral-600">
          The API is not answering. Start the mock with{' '}
          <code className="font-mono text-sm">pnpm mock</code> and reload.
        </p>
      </main>
    )
  }

  const probed = stats.probed.agentsProbed
  const states = Object.entries(stats.probed.byState) as [LivenessState, number][]
  const working = stats.probed.byState.LIVE ?? 0

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-14">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">
          BNB Smart Chain · ERC-8004
        </p>
        <h1 className="display max-w-3xl">
          {stats.indexed.bscAgents.toLocaleString()} agents are registered.
          <br />
          <span className="text-aiki-orange">
            {working === 0 ? 'None' : working} of the {probed} we probed can actually be hired.
          </span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-neutral-600">
          Everyone else counts registrations. We probe them — with a valid ID, a nonsense ID, and a
          non-numeric one. An endpoint that answers the same way to all three is not an agent.
        </p>
      </header>

      {/* What we found. The whole point of the page. */}
      <section className="mb-14">
        <h2 className="mb-5 font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">
          What {probed} probes found
        </h2>
        <div className="edge-enforced rounded-xl bg-white">
          {states
            .sort((a, b) => b[1] - a[1])
            .map(([state, n], i) => {
              const copy = STATE_COPY[state]
              return (
                <div
                  key={state}
                  className={`flex items-baseline gap-5 px-6 py-4 ${i > 0 ? 'border-t border-neutral-200' : ''}`}
                >
                  <div className="tnum w-20 shrink-0 text-right font-mono text-lg">{n}</div>
                  <div className="tnum w-16 shrink-0 text-right font-mono text-sm text-neutral-400">
                    {pct(n, probed)}
                  </div>
                  <div className="min-w-0">
                    <div className={`font-medium ${TONE[copy.tone]}`}>{copy.label}</div>
                    <div className="text-sm text-neutral-500">{copy.blurb}</div>
                  </div>
                </div>
              )
            })}
        </div>
      </section>

      {/* Reputation — the number everyone renders, and why we do not. */}
      <section className="mb-14 grid gap-4 sm:grid-cols-3">
        <Stat
          value={stats.reputation.totalFeedback.toLocaleString()}
          label="reviews on-chain"
          note="what other products show you"
        />
        <Stat
          value={stats.reputation.withPaymentProof.toLocaleString()}
          label="backed by a real payment"
          note="what we count"
          emphasis
        />
        <Stat
          value={`${stats.reputation.sybilFlaggedPct}%`}
          label="reviewers flagged coordinated"
          note="independently measured"
        />
      </section>

      {/* Corrections. Being the product that fixes the ecosystem's own numbers. */}
      {stats.corrections?.length ? (
        <section className="mb-14">
          <h2 className="mb-5 font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">
            Figures we found to be stale
          </h2>
          {stats.corrections.map((c) => (
            <div key={c.claim} className="edge-provisional rounded-xl bg-aiki-yellow/25 px-6 py-5">
              <p className="text-sm text-neutral-600 line-through decoration-neutral-400">
                {c.claim}
              </p>
              <p className="mt-1.5 font-medium">{c.actual}</p>
              <p className="mt-2 font-mono text-xs text-neutral-500">{c.source}</p>
            </div>
          ))}
        </section>
      ) : null}

      <footer className="border-t border-neutral-200 pt-6 font-mono text-xs text-neutral-400">
        indexed to block {stats.indexed.lastIndexedBlock.toLocaleString()} · last probe sweep{' '}
        {new Date(stats.probed.lastProbeSweepAt).toUTCString()} ·{' '}
        <Link href="/discover" className="underline hover:text-neutral-700">
          browse agents →
        </Link>
      </footer>
    </main>
  )
}

function Stat({
  value,
  label,
  note,
  emphasis,
}: {
  value: string
  label: string
  note: string
  emphasis?: boolean
}) {
  return (
    <div
      className={`rounded-xl bg-white px-5 py-5 ${emphasis ? 'edge-enforced' : 'edge-observed'}`}
    >
      <div className={`tnum font-mono text-3xl ${emphasis ? 'text-aiki-orange' : ''}`}>{value}</div>
      <div className="mt-1 text-sm font-medium">{label}</div>
      <div className="mt-0.5 text-xs text-neutral-500">{note}</div>
    </div>
  )
}
