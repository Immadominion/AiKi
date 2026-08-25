'use client'

import type { LivenessState } from '@aiki/contracts'
import { useEffect, useState } from 'react'
import { api } from './api'

/**
 * Registry truth for the coverage block: how many agents exist, how many we
 * probed, how many answered at all, and why the rest were left out.
 *
 * Served from /v1/stats when the API is reachable. When it is not, the numbers
 * fall back to the committed 20 Aug 2026 probe sweep — older measurements, not
 * invented ones — and the block says which of the two it is showing.
 */
export interface RegistryCoverage {
  indexed: number
  probed: number
  /** LIVE + DEGRADED: everything that answered like an agent at all. */
  answering: number
  reasons: { state: LivenessState; count: number }[]
  freshness: 'live' | 'cached'
  sweptAt: string
}

export const SWEEP_COVERAGE: RegistryCoverage = {
  indexed: 12_847,
  probed: 400,
  answering: 2,
  reasons: [
    { state: 'DECLARED_ONLY', count: 243 },
    { state: 'IMPOSTOR_STATIC', count: 133 },
    { state: 'PLACEHOLDER_URL', count: 22 },
  ],
  freshness: 'cached',
  sweptAt: '2026-08-20T10:25:42.243Z',
}

let cached: RegistryCoverage | null = null
let inflight: Promise<RegistryCoverage> | null = null

async function load(): Promise<RegistryCoverage> {
  const stats = await api.stats()
  const byState = stats.probed.byState
  const answering = (byState.LIVE ?? 0) + (byState.DEGRADED ?? 0)
  const reasons = (Object.entries(byState) as [LivenessState, number][])
    .filter(([state]) => state !== 'LIVE' && state !== 'DEGRADED')
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count)
  return {
    indexed: stats.indexed.totalAgents,
    probed: stats.probed.agentsProbed,
    answering,
    reasons,
    freshness: 'live',
    sweptAt: stats.probed.lastProbeSweepAt,
  }
}

export function useRegistryCoverage(): RegistryCoverage {
  const [coverage, setCoverage] = useState<RegistryCoverage>(cached ?? SWEEP_COVERAGE)
  useEffect(() => {
    if (cached) return
    inflight ??= load()
    let alive = true
    inflight.then(
      (live) => {
        cached = live
        if (alive) setCoverage(live)
      },
      () => {
        // Sweep numbers stay up; the next mount retries the API.
        inflight = null
      },
    )
    return () => {
      alive = false
    }
  }, [])
  return coverage
}
