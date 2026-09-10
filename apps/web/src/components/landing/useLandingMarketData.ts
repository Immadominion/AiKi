'use client'

import { hasCurrentLiveness } from '@aiki/contracts/probe-freshness'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useProbeExpiry } from '@/lib/use-probe-expiry'
import {
  COMMITTED_LANDING_SWEEP,
  type LandingMarketData,
  landingAgentNodesFromPassports,
  landingAggregateFromStats,
} from './market-data'

type InternalState = Omit<LandingMarketData, 'refresh'>

const INITIAL_STATE: InternalState = {
  status: 'loading',
  aggregateStatus: 'loading',
  agentsStatus: 'loading',
  aggregate: COMMITTED_LANDING_SWEEP,
  agents: [],
  fetchedAt: null,
  refreshing: false,
  errors: { aggregate: null, agents: null },
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'The evidence API did not answer.'

async function loadLandingMarketSnapshot(): Promise<InternalState> {
  const [aggregateResult, agentsResult] = await Promise.allSettled([
    api.stats().then(landingAggregateFromStats),
    api
      .search({ filters: { liveness: ['LIVE', 'DEGRADED'] }, limit: 100 })
      .then((response) => landingAgentNodesFromPassports(response.results)),
  ])

  const aggregateLive = aggregateResult.status === 'fulfilled'
  const agentsLive = agentsResult.status === 'fulfilled'

  return {
    status: aggregateLive ? (agentsLive ? 'live' : 'error') : 'fallback',
    aggregateStatus: aggregateLive ? 'live' : 'fallback',
    agentsStatus: agentsLive ? 'live' : 'error',
    aggregate: aggregateLive ? aggregateResult.value : COMMITTED_LANDING_SWEEP,
    agents: agentsLive ? agentsResult.value : [],
    fetchedAt: new Date().toISOString(),
    refreshing: false,
    errors: {
      aggregate: aggregateResult.status === 'rejected' ? messageOf(aggregateResult.reason) : null,
      agents: agentsResult.status === 'rejected' ? messageOf(agentsResult.reason) : null,
    },
  }
}

/**
 * Live public evidence for the landing market.
 *
 * Aggregate failure falls back to the dated committed sweep. Search failure
 * returns no agent nodes, because there is no honest individual fallback.
 */
export function useLandingMarketData(): LandingMarketData {
  const [state, setState] = useState<InternalState>(INITIAL_STATE)
  useProbeExpiry(state.agents.map((agent) => agent.lastProbeAt))
  const requestRef = useRef(0)
  const pendingRef = useRef(false)

  const load = useCallback(async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    const request = ++requestRef.current
    try {
      const next = await loadLandingMarketSnapshot()
      if (request === requestRef.current) setState(next)
    } finally {
      if (request === requestRef.current) pendingRef.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    setState((current) => ({ ...current, refreshing: true }))
    void load()
  }, [load])

  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== 'hidden') void load()
    }
    refreshVisible()
    const timer = setInterval(refreshVisible, 60_000)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      requestRef.current += 1
      pendingRef.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [load])

  return {
    ...state,
    agents: state.agents.filter((agent) => hasCurrentLiveness(agent, ['LIVE', 'DEGRADED'])),
    refresh,
  }
}
