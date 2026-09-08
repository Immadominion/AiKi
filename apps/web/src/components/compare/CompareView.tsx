'use client'

import type { Measure } from '@aiki/contracts'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { PageCard } from '@/components/shell/PageCard'
import { AGENTS, type AgentKey } from '@/lib/agents'
import { api } from '@/lib/api'
import { overlaps, separation, timeFor } from '@/lib/compare'
import {
  type CompareSubject,
  isAgentId,
  subjectFromFixture,
  subjectFromPassport,
} from '@/lib/compare-subjects'
import { type Counts, DETAILS } from '@/lib/detail'
import { formatScore } from '@/lib/format'
import { aikiProbe, measureFrom } from '@/lib/measure'
import { agentHref, registryHref, route } from '@/lib/routes'

const OBSERVED = '2026-08-22T04:10:00Z'
const m = (c: Counts): Measure => measureFrom(c[0], c[1], aikiProbe(OBSERVED))

const ROWS = [
  { label: 'Overall', pick: (s: CompareSubject) => s.checks },
  { label: 'Answers when asked', pick: (s: CompareSubject) => s.components.liveness },
  {
    label: 'Finishes what it starts',
    pick: (s: CompareSubject) => s.components.executionReliability,
  },
  { label: 'Result was worth it', pick: (s: CompareSubject) => s.components.outcomeQuality },
  { label: 'What others report', pick: (s: CompareSubject) => s.components.reputation },
  { label: 'Stayed inside its limits', pick: (s: CompareSubject) => s.components.safety },
] as const

function ScoreCell({ counts }: { counts: Counts | null }) {
  if (!counts || counts[1] === 0) {
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

  const asked = useMemo(
    () =>
      (params.get('agents') ?? 'guardian,sentinel')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3),
    [params],
  )

  /*
   * Real agents are named by their token id, examples by a word. Asking to
   * compare 315943 with 315944 used to fall through the fixture filter and
   * silently render Guardian against Sentinel, so the page answered a question
   * nobody asked with numbers nobody measured.
   */
  const wantsRegistry = asked.some(isAgentId)
  const [live, setLive] = useState<CompareSubject[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!wantsRegistry) return
    let cancelled = false
    setLive(null)
    setFailed(false)
    api
      .compare(asked.filter(isAgentId))
      .then((answer) => {
        if (!cancelled) setLive(answer.agents.map(subjectFromPassport))
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [asked, wantsRegistry])

  const fixtures = useMemo(() => {
    const valid = asked.filter((k): k is AgentKey => k in DETAILS)
    const keys = valid.length >= 2 ? valid : (['guardian', 'sentinel'] as AgentKey[])
    return keys.slice(0, 3).map(subjectFromFixture)
  }, [asked])

  const subjects = wantsRegistry ? live : fixtures

  if (failed)
    return (
      <PageCard
        title="Compare"
        count=""
        back={{ href: '/explore', label: 'Explore' }}
        tabs={[]}
        tabHint=""
      >
        <p className="max-w-[620px] text-[13.5px]">
          The registry could not be reached, so there is nothing to compare. This page will not fall
          back to the example agents: a comparison of two agents you did not ask about is worse than
          no comparison.
        </p>
      </PageCard>
    )
  if (!subjects)
    return (
      <PageCard
        title="Compare"
        count=""
        back={{ href: '/explore', label: 'Explore' }}
        tabs={[]}
        tabHint=""
      >
        <p className="text-muted text-[13.5px]">Reading both passports…</p>
      </PageCard>
    )
  if (subjects.length < 2)
    return (
      <PageCard
        title="Compare"
        count=""
        back={{ href: '/explore', label: 'Explore' }}
        tabs={[]}
        tabHint=""
      >
        <p className="max-w-[620px] text-[13.5px]">Two agents are needed to compare.</p>
      </PageCard>
    )

  const byKey = new Map(subjects.map((s) => [s.key, s]))
  const keys = subjects.map((s) => s.key)
  const S = (k: string): CompareSubject => byKey.get(k) as CompareSubject
  const a = keys[0] as string
  const b = keys[1] as string
  const grid = {
    gridTemplateColumns: `minmax(180px,1.2fr) repeat(${keys.length}, minmax(140px,1fr))`,
    minWidth: 480,
  }

  const aM = m(S(a).checks)
  const bM = m(S(b).checks)
  const tied = overlaps(aM, bM)

  // The thinner sample is the one that would have to grow to settle it.
  const thinKey = S(a).checks[1] <= S(b).checks[1] ? a : b
  const fatKey = thinKey === a ? b : a
  const sep = separation(S(thinKey).checks, m(S(fatKey).checks))

  // Cadence, straight from what we have actually observed of this agent.
  const daysKnown = Math.max(
    1,
    Math.round((Date.parse(OBSERVED) - Date.parse(S(thinKey).registeredAt)) / 86_400_000),
  )
  const perDay = S(thinKey).checks[1] / daysKnown

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <div className="flex flex-none items-center">
        {keys.map((k, i) => (
          <span
            key={k}
            className="flex size-[46px] items-center justify-center rounded-[15px] text-[18px] font-extrabold text-white ring-2 ring-white"
            style={{ background: S(k).bg, marginLeft: i ? -12 : 0 }}
          >
            {S(k).initial}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1 basis-[240px]">
        <span className="block text-[19px] font-extrabold tracking-[-0.02em]">
          {keys.map((k) => S(k).name).join(' vs ')}
        </span>
        <p className="text-muted mt-[3px] mb-0 text-[13px] leading-[1.45]">
          {/* This used to assert that both agents claim the same work, which was
              true of the two examples it was written for and is not true of any
              two agents a visitor picks. What IS always true is the second half. */}
          Compared on evidence AiKi collected itself
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
            <div className="min-w-0 flex-1 basis-[240px]">
              <div
                className="text-[15px] font-bold"
                style={{ color: tied ? '#6B5A34' : 'var(--color-good-ink)' }}
              >
                {tied
                  ? 'We cannot tell these apart yet.'
                  : `${S(fatKey).name} is ahead on the evidence.`}
              </div>

              <p
                className="mt-[6px] mb-0 max-w-[660px] text-[13px] leading-[1.55] text-pretty"
                style={{ color: tied ? '#6B5A34' : 'var(--color-good-ink)' }}
              >
                {tied ? (
                  <>
                    {S(a).name} scores{' '}
                    <b className="font-bold tabular-nums">{formatScore(aM).text}</b> on a range of{' '}
                    {(aM.interval?.[0] ?? 0).toFixed(0)}–{(aM.interval?.[1] ?? 0).toFixed(0)};{' '}
                    {S(b).name} scores{' '}
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
                        Nothing we can wait for. At {S(thinKey).name}&rsquo;s observed rate its
                        range settles overlapping {S(fatKey).name}&rsquo;s, so more of the same
                        evidence will not separate them. A head-to-head run on identical inputs
                        would.
                      </>
                    ) : (
                      <>
                        About <b className="font-bold tabular-nums">{sep.checksNeeded}</b> more
                        checks on {S(thinKey).name}, {timeFor(sep.checksNeeded, perDay)} at the{' '}
                        {perDay.toFixed(1)} a day we have actually seen. If its current rate holds
                        it would land {sep.wouldLand} {S(fatKey).name}, but that is a projection,
                        not a result.
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
                  style={{ background: S(k).bg }}
                >
                  {S(k).initial}
                </span>
                <span className="text-[13px] font-bold">{S(k).name}</span>
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
                  <ScoreCell counts={r.pick(S(k))} />
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
                {S(k).price}
              </div>
            ))}
          </div>

          <div className="grid" style={grid}>
            <div className="flex items-center px-[14px] py-[13px] text-[13.5px] font-semibold">
              Weakest limit held by
            </div>
            {keys.map((k) => {
              const soft = S(k).softEnforcement
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
          means we have never seen that agent do that thing. It is not a zero, and we will not print
          one.
        </p>

        <div className="mt-[18px] flex flex-wrap items-center gap-[8px]">
          <span className="text-muted text-[12.5px] font-semibold">Compare {S(a).name} with</span>
          {(wantsRegistry ? [] : AGENTS.filter((x) => x.key !== a)).map((x) => (
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
            onClick={() => router.push(wantsRegistry ? registryHref(a) : agentHref(a))}
            className="text-ink-app h-[32px] rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
          >
            Open {S(a).name} →
          </button>
        </div>
      </div>
    </PageCard>
  )
}
