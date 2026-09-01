'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
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
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestRef.current
    const next = await loadLandingMarketSnapshot()
    if (request === requestRef.current) setState(next)
  }, [])

  const refresh = useCallback(() => {
    setState((current) => ({ ...current, refreshing: true }))
    void load()
  }, [load])

  useEffect(() => {
    void load()
    return () => {
      requestRef.current += 1
    }
  }, [load])

  return { ...state, refresh }
}
