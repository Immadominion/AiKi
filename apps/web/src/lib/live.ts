'use client'

import type { EcosystemStats, LivenessState } from '@aiki/contracts'
import { useEffect, useState } from 'react'
import { api } from './api'

/**
 * Registry truth for the coverage block: how many agents exist, how many we
 * probed, how many answered at all, and why the rest were left out.
 *
 * Served from /v1/stats when the API is reachable. When it is not, the numbers
 * fall back to the committed 20 Aug 2026 probe sweep - older measurements, not
 * invented ones - and the block says which of the two it is showing.
 */
export interface RegistryCoverage {
  /** Null when no chain-indexer evidence exists yet; probing alone cannot fake it. */
  indexed: number | null
  /**
   * False when the index began after the registry's first block, which makes
   * `indexed` a count of what we have seen rather than of what exists. The
   * difference has to reach the reader, or a partial index reads as the whole
   * registry.
   */
  indexComplete: boolean
  probed: number
  /** LIVE + DEGRADED with current checks. Cached sweeps remain explicitly historical. */
  answering: number
  /** Previously answering agents excluded from the current count, not declared offline. */
  awaitingRecheck?: number
  reasons: { state: LivenessState; count: number }[]
  /**
   * Three states, not two. `asking` is the truth before the API answers: the
   * sweep numbers below are real measurements, just older ones, and we have not
   * yet learned whether newer ones exist. Rendering that as `cached` made every
   * cold load spend two seconds asserting the API was unreachable before it had
   * been asked, which is the one thing this product may never do.
   */
  freshness: 'live' | 'cached' | 'asking'
  sweptAt: string | null
}

/**
 * The last sweep, as measured. Used only when the API cannot be reached.
 *
 * `indexed` is null on purpose. There was a number here once, 12,847, and it
 * came from nowhere: no sweep produced it and no observation contains it. It
 * rendered as "agents indexed so far on BNB Chain" under a label saying it came
 * from a probe sweep. Not knowing how large the registry is, and saying so, is
 * the only honest thing this file can do offline.
 */
export const SWEEP_COVERAGE: RegistryCoverage = {
  indexed: null,
  probed: 400,
  answering: 2,
  indexComplete: false,
  reasons: [
    { state: 'DECLARED_ONLY', count: 243 },
    { state: 'IMPOSTOR_STATIC', count: 133 },
    { state: 'PLACEHOLDER_URL', count: 22 },
  ],
  freshness: 'cached',
  sweptAt: '2026-08-20T10:25:42.243Z',
}

let cached: RegistryCoverage | null = null
let cachedAt = 0
let inflight: Promise<RegistryCoverage> | null = null
const REFRESH_MS = 60_000

export function coverageFromStats(stats: EcosystemStats): RegistryCoverage {
  const byState = stats.probed.byState
  if (!stats.probed.currentByState)
    throw new Error('Current registry check counts are unavailable.')
  for (const state of ['LIVE', 'DEGRADED'] as const) {
    const current = stats.probed.currentByState[state] ?? 0
    const historical = byState[state] ?? 0
    if (
      !Number.isSafeInteger(current) ||
      current < 0 ||
      !Number.isSafeInteger(historical) ||
      current > historical
    )
      throw new Error('The registry answering counts are inconsistent.')
  }
  const answering =
    (stats.probed.currentByState.LIVE ?? 0) + (stats.probed.currentByState.DEGRADED ?? 0)
  const historicalAnswering = (byState.LIVE ?? 0) + (byState.DEGRADED ?? 0)
  if (
    !Number.isSafeInteger(answering) ||
    answering < 0 ||
    answering > historicalAnswering ||
    historicalAnswering > stats.probed.agentsProbed
  )
    throw new Error('The registry answering counts are inconsistent.')
  const reasons = (Object.entries(byState) as [LivenessState, number][])
    .filter(([state]) => state !== 'LIVE' && state !== 'DEGRADED')
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count)
  return {
    indexed: stats.indexed?.totalAgents ?? null,
    indexComplete: stats.indexed?.complete ?? false,
    probed: stats.probed.agentsProbed,
    answering,
    awaitingRecheck: historicalAnswering - answering,
    reasons,
    freshness: 'live',
    sweptAt: stats.probed.lastProbeSweepAt,
  }
}

function load(): Promise<RegistryCoverage> {
  inflight ??= api
    .stats()
    .then(coverageFromStats)
    .then((coverage) => {
      cached = coverage
      cachedAt = Date.now()
      return coverage
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useRegistryCoverage(): RegistryCoverage {
  const [coverage, setCoverage] = useState<RegistryCoverage>(() =>
    cached && Date.now() - cachedAt < REFRESH_MS
      ? cached
      : { ...(cached ?? SWEEP_COVERAGE), freshness: 'asking' },
  )
  useEffect(() => {
    let alive = true
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      if (cached && Date.now() - cachedAt < REFRESH_MS) {
        setCoverage(cached)
        return
      }
      void load().then(
        (live) => {
          if (alive) setCoverage(live)
        },
        () => {
          // Retain actual last-known measurements instead of replacing newer
          // data with the committed fallback after a refresh fails.
          if (alive) setCoverage(cached ? { ...cached, freshness: 'cached' } : SWEEP_COVERAGE)
        },
      )
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  return coverage
}
