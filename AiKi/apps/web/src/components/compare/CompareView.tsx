'use client'

import type { Measure } from '@aiki/contracts'
import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'
import { PageCard } from '@/components/shell/PageCard'
import { AGENT_BG, AGENT_BY_KEY, AGENTS, type AgentKey } from '@/lib/agents'
import { overlaps, separation, timeFor } from '@/lib/compare'
import { type Counts, DETAILS } from '@/lib/detail'
import { formatScore } from '@/lib/format'
import { aikiProbe, measureFrom } from '@/lib/measure'
import { agentHref, route } from '@/lib/routes'

const OBSERVED = '2026-08-22T04:10:00Z'
const m = (c: Counts): Measure => measureFrom(c[0], c[1], aikiProbe(OBSERVED))

const ROWS = [
  { label: 'Overall', pick: (k: AgentKey) => DETAILS[k].checks },
  { label: 'Answers when asked', pick: (k: AgentKey) => DETAILS[k].components.liveness },
  {
    label: 'Finishes what it starts',
    pick: (k: AgentKey) => DETAILS[k].components.executionReliability,
  },
  { label: 'Result was worth it', pick: (k: AgentKey) => DETAILS[k].components.outcomeQuality },
  { label: 'What others report', pick: (k: AgentKey) => DETAILS[k].components.reputation },
  { label: 'Stayed inside its limits', pick: (k: AgentKey) => DETAILS[k].components.safety },
] as const

function ScoreCell({ counts }: { counts: Counts }) {
  if (counts[1] === 0) {
    return <span className="text-faint text-[13px] font-semibold">never observed</span>
  }
  const measure = m(counts)
  const { text, withheld } = formatScore(measure)
  const [lo, hi] = measure.interval ?? [measure.value, measure.value]

  return (
    <span className="min-w-0">
      <span
        className="block text-[17px] font-extrabold tabular-nums"
        style={{ color: withheld ? 'var(--color-faint)' : 'var(--color-ink-app)' }}
      >
        {text}
      </span>
      <span className="text-muted mt-[3px] block text-[11.5px] font-medium tabular-nums">
        {lo.toFixed(0)}–{hi.toFixed(0)} · {counts[1]} checks
      </span>
    </span>
  )
}

export function CompareView() {
  const params = useSearchParams()
  const router = useRouter()

  const keys = useMemo(() => {
    const raw = (params.get('agents') ?? 'guardian,sentinel')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is AgentKey => s in DETAILS)
    return (raw.length >= 2 ? raw : (['guardian', 'sentinel'] as AgentKey[])).slice(0, 3)
  }, [params])

  const a = keys[0] as AgentKey
  const b = keys[1] as AgentKey
  const grid = {
    gridTemplateColumns: `minmax(180px,1.2fr) repeat(${keys.length}, minmax(140px,1fr))`,
    minWidth: 480,
  }

  const aM = m(DETAILS[a].checks)
  const bM = m(DETAILS[b].checks)
  const tied = overlaps(aM, bM)

  // The thinner sample is the one that would have to grow to settle it.
  const thinKey = DETAILS[a].checks[1] <= DETAILS[b].checks[1] ? a : b
  const fatKey = thinKey === a ? b : a
  const sep = separation(DETAILS[thinKey].checks, m(DETAILS[fatKey].checks))

  // Cadence, straight from what we have actually observed of this agent.
  const daysKnown = Math.max(
    1,
    Math.round((Date.parse(OBSERVED) - Date.parse(DETAILS[thinKey].registeredAt)) / 86_400_000),
  )
  const perDay = DETAILS[thinKey].checks[1] / daysKnown

  const header = (
    <div className="flex items-start gap-[14px]">
      <div className="flex flex-none items-center">
        {keys.map((k, i) => (
          <span
            key={k}
            className="flex size-[46px] items-center justify-center rounded-[15px] text-[18px] font-extrabold text-white ring-2 ring-white"
            style={{ background: AGENT_BG[k], marginLeft: i ? -12 : 0 }}
          >
            {AGENT_BY_KEY[k].initial}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <span className="block text-[19px] font-extrabold tracking-[-0.02em]">
          {keys.map((k) => AGENT_BY_KEY[k].name).join(' vs ')}
        </span>
        <p className="text-muted mt-[3px] mb-0 text-[13px] leading-[1.45]">
          Both claim the same work · compared on evidence AiKi collected itself
        </p>
      </div>
    </div>
  )

  return (
    <PageCard
      title="Compare"
      count=""
      back={{ href: '/explore', label: 'Explore' }}
      headerSlot={header}
      tabs={[]}
      tabHint=""
    >
      <div className="max-w-[900px]">
        {/* The verdict, which is usually "we cannot tell yet". Saying so is the
            product; a ranked list here would be the easy lie. */}
        <div
          className="rounded-[18px] px-[18px] py-[16px]"
          style={{ background: tied ? 'var(--color-warn-bg)' : 'var(--color-good-bg)' }}
        >
          <div className="flex items-start gap-[11px]">
            <span
              className="mt-px flex size-[22px] flex-none items-center justify-center rounded-[8px] text-[12px] font-extrabold text-white"
              style={{ background: tied ? 'var(--color-warn)' : 'var(--color-good)' }}
            >
              {tied ? '=' : '✓'}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className="text-[15px] font-bold"
                style={{ color: tied ? '#6B5A34' : 'var(--color-good-ink)' }}
              >
                {tied
                  ? 'We cannot tell these apart yet.'
                  : `${AGENT_BY_KEY[fatKey].name} is ahead on the evidence.`}
              </div>

              <p
                className="mt-[6px] mb-0 max-w-[660px] text-[13px] leading-[1.55] text-pretty"
                style={{ color: tied ? '#6B5A34' : 'var(--color-good-ink)' }}
              >
                {tied ? (
                  <>
                    {AGENT_BY_KEY[a].name} scores{' '}
                    <b className="font-bold tabular-nums">{formatScore(aM).text}</b> on a range of{' '}
                    {(aM.interval?.[0] ?? 0).toFixed(0)}–{(aM.interval?.[1] ?? 0).toFixed(0)};{' '}
                    {AGENT_BY_KEY[b].name} scores{' '}
                    <b className="font-bold tabular-nums">{formatScore(bM).text}</b> on{' '}
                    {(bM.interval?.[0] ?? 0).toFixed(0)}–{(bM.interval?.[1] ?? 0).toFixed(0)}. Those
                    ranges overlap, so the difference you can see is smaller than the uncertainty
                    behind it. Ranking them would be inventing a result.
                  </>
                ) : (
                  <>
                    Their ranges do not overlap, so this is a real difference and not an artefact of
                    how much we have watched each of them.
                  </>
                )}
              </p>

              {tied ? (
                <div className="mt-[13px] rounded-[13px] bg-white/70 px-[13px] py-[11px]">
                  <div className="text-[12.5px] font-bold text-[#6B5A34]">What would settle it</div>
                  <p className="mt-[4px] mb-0 text-[12.5px] leading-[1.55] text-pretty text-[#6B5A34]">
                    {sep.checksNeeded === null ? (
                      <>
                        Nothing we can wait for. At {AGENT_BY_KEY[thinKey].name}&rsquo;s observed
                        rate its range settles overlapping {AGENT_BY_KEY[fatKey].name}&rsquo;s, so
                        more of the same evidence will not separate them. A head-to-head run on
                        identical inputs would.
                      </>
                    ) : (
                      <>
                        About <b className="font-bold tabular-nums">{sep.checksNeeded}</b> more
                        checks on {AGENT_BY_KEY[thinKey].name} — {timeFor(sep.checksNeeded, perDay)}{' '}
                        at the {perDay.toFixed(1)} a day we have actually seen. If its current rate
                        holds it would land {sep.wouldLand} {AGENT_BY_KEY[fatKey].name}, but that is
                        a projection, not a result.
                      </>
                    )}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-[18px] overflow-x-auto rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          <div className="bg-surface-sunk grid border-b border-[rgb(26_26_25_/_0.08)]" style={grid}>
            <div className="px-[14px] py-[11px] text-[13px] font-bold text-[#4A4A46]">Measured</div>
            {keys.map((k) => (
              <div
                key={k}
                className="flex items-center gap-[9px] border-l border-[rgb(26_26_25_/_0.06)] px-[14px] py-[11px]"
              >
                <span
                  className="flex size-[24px] flex-none items-center justify-center rounded-[8px] text-[11px] font-extrabold text-white"
                  style={{ background: AGENT_BG[k] }}
                >
                  {AGENT_BY_KEY[k].initial}
                </span>
                <span className="text-[13px] font-bold">{AGENT_BY_KEY[k].name}</span>
              </div>
            ))}
          </div>

          {ROWS.map((r) => (
            <div key={r.label} className="grid border-b border-[rgb(26_26_25_/_0.06)]" style={grid}>
              <div className="flex items-center px-[14px] py-[13px] text-[13.5px] font-semibold">
                {r.label}
              </div>
              {keys.map((k) => (
                <div key={k} className="border-l border-[rgb(26_26_25_/_0.05)] px-[14px] py-[13px]">
                  <ScoreCell counts={r.pick(k)} />
                </div>
              ))}
            </div>
          ))}

          <div className="grid border-b border-[rgb(26_26_25_/_0.06)]" style={grid}>
            <div className="flex items-center px-[14px] py-[13px] text-[13.5px] font-semibold">
              Price
            </div>
            {keys.map((k) => (
              <div
                key={k}
                className="border-l border-[rgb(26_26_25_/_0.05)] px-[14px] py-[13px] text-[14px] font-extrabold tabular-nums"
              >
                {AGENT_BY_KEY[k].price}
              </div>
            ))}
          </div>

          <div className="grid" style={grid}>
            <div className="flex items-center px-[14px] py-[13px] text-[13.5px] font-semibold">
              Weakest limit held by
            </div>
            {keys.map((k) => {
              const soft = DETAILS[k].enforcement.some((e) => e.tier !== 'T0' || !e.verified)
              return (
                <div key={k} className="border-l border-[rgb(26_26_25_/_0.05)] px-[14px] py-[13px]">
                  <span
                    className="rounded-full px-[9px] py-[3px] text-[11.5px] font-bold"
                    style={
                      soft
                        ? { background: 'var(--color-warn-bg)', color: 'var(--color-warn-ink)' }
                        : { background: 'rgb(26 26 25 / 0.05)', color: 'var(--color-muted)' }
                    }
                  >
                    {soft ? 'Not the chain' : 'The chain'}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        <p className="text-muted mt-[14px] mb-0 max-w-[680px] text-[12.5px] leading-[1.5] text-pretty">
          Every figure is the lower end of a range, computed from the checks behind it. A blank
          means we have never seen that agent do that thing — it is not a zero, and we will not
          print one.
        </p>

        <div className="mt-[18px] flex flex-wrap items-center gap-[8px]">
          <span className="text-muted text-[12.5px] font-semibold">
            Compare {AGENT_BY_KEY[a].name} with
          </span>
          {AGENTS.filter((x) => x.key !== a).map((x) => (
            <button
              key={x.key}
              type="button"
              onClick={() => router.push(route(`/compare?agents=${a},${x.key}`))}
              className="h-[32px] rounded-[11px] border-0 px-[12px] text-[12.5px] font-semibold transition-colors"
              style={
                x.key === b
                  ? { background: 'var(--color-ink-app)', color: '#fff' }
                  : { background: 'rgb(26 26 25 / 0.055)', color: 'var(--color-body)' }
              }
            >
              {x.name}
            </button>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => router.push(agentHref(a))}
            className="text-ink-app h-[32px] rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
          >
            Open {AGENT_BY_KEY[a].name} →
          </button>
        </div>
      </div>
    </PageCard>
  )
}
