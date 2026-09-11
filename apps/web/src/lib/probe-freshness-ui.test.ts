import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EcosystemStats, ProjectedPassport, ProjectedSearchResponse } from '@aiki/contracts'
import { act, createElement, Fragment, useLayoutEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { isGuardianPassport } from '../components/hire/subject'
import { liveShards } from '../components/home/live-shards'
import {
  type LandingMarketData,
  landingAgentNodesFromPassports,
  landingAggregateFromStats,
  landingAnsweringEvidence,
} from '../components/landing/market-data'
import { useLandingMarketData } from '../components/landing/useLandingMarketData'
import { LivenessBadge, livenessPresentation } from '../components/ui/LivenessBadge'
import { api } from './api'
import { coverageFromStats, type RegistryCoverage, useRegistryCoverage } from './live'
import { useProbeExpiry } from './use-probe-expiry'

const now = Date.parse('2026-09-10T16:00:00.000Z')
const old = new Date(now - 86_400_001).toISOString()
function passport(lastProbeAt: string | null): ProjectedPassport {
  return {
    agentId: '315943',
    chainId: 56,
    registry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    name: 'Venus Guardian',
    description: 'Checks a Venus position.',
    liveness: 'LIVE',
    livenessDetail: 'Answered the checks.',
    lastProbeAt,
    p95LatencyMs: 100,
    checks: { trials: 20, successes: 20 },
    proofScore: {
      value: 0.8,
      confidence: 0.95,
      interval: [0.8, 1],
      sampleSize: 20,
      method: 'wilson',
    },
    components: {
      liveness: { trials: 20, successes: 20 },
      executionReliability: null,
      outcomeQuality: null,
      reputation: null,
      safety: null,
    },
    identity: {
      tokenId: '315943',
      owner: null,
      createdAt: null,
      registrationFile: {
        resolved: true,
        uriScheme: 'https',
        reciprocalProofVerified: true,
        zeroCost: true,
      },
    },
    risks: [],
    evidence: [],
    updatedAt: lastProbeAt,
    insufficientEvidence: false,
  }
}
function stats(currentLive = 2): EcosystemStats {
  return {
    indexed: null,
    probed: {
      agentsProbed: 100,
      byState: { LIVE: 10, DEGRADED: 5, UNREACHABLE: 85 },
      currentByState: { LIVE: currentLive, DEGRADED: 1 },
      staleAgents: 97 - currentLive,
      lastProbeSweepAt: new Date(now).toISOString(),
    },
    reputation: null,
    categories: {},
  }
}

test('an expired verdict stays historical, never green or newly unreachable', () => {
  assert.deepEqual(livenessPresentation('LIVE', old, now), {
    label: 'Last known: answering',
    tone: 'idle',
  })
  assert.deepEqual(livenessPresentation('UNREACHABLE', old, now), {
    label: 'Last known: not answering',
    tone: 'idle',
  })
  assert.deepEqual(livenessPresentation('LIVE', new Date(now - 86_400_000).toISOString(), now), {
    label: 'Answering',
    tone: 'good',
  })
  assert.deepEqual(livenessPresentation('DEGRADED', new Date(now).toISOString(), now), {
    label: 'Requires review',
    tone: 'warn',
  })
  for (const value of [null, undefined, 'not-a-time', new Date(now + 1).toISOString()])
    assert.deepEqual(livenessPresentation('LIVE', value, now), {
      label: 'Check needed',
      tone: 'idle',
    })
  assert.equal(livenessPresentation('UNPROBED', null, now).label, 'Not tested yet')
})

test('long historical status labels can wrap without changing the shared pill default', () => {
  const html = renderToStaticMarkup(
    createElement(LivenessBadge, { state: 'LIVE', lastProbeAt: '2000-01-01T00:00:00.000Z' }),
  )
  assert.match(html, /Last known: answering/)
  assert.match(html, /whitespace-normal/)
  assert.doesNotMatch(html, /whitespace-nowrap/)
})

test('old Guardian evidence cannot enable hiring or create answering landing nodes', () => {
  const current = passport(new Date().toISOString())
  assert.equal(isGuardianPassport(current), true)
  assert.equal(landingAgentNodesFromPassports([current]).length, 1)
  for (const value of [
    null,
    '2000-01-01T00:00:00.000Z',
    'bad-time',
    new Date(Date.now() + 60_000).toISOString(),
  ]) {
    const historical = passport(value)
    // A stale cached metadata flag is not authoritative.
    historical.livenessFreshness = { state: 'LIVE', checkedAt: value, expiresAt: null, ageMs: 0 }
    assert.equal(isGuardianPassport(historical), false)
    assert.deepEqual(landingAgentNodesFromPassports([historical]), [])
    assert.equal(historical.liveness, 'LIVE')
  }
})

test('existing card artwork stays stable while old checks receive a neutral label', () => {
  const fresh = liveShards([passport(new Date().toISOString())])[0]
  const stale = liveShards([passport('2000-01-01T00:00:00.000Z')])[0]
  assert.ok(fresh && stale)
  assert.equal(fresh.bg, stale.bg)
  assert.equal(fresh.name, stale.name)
  assert.match(stale.state, /Last known: answering/)
  assert.equal(stale.stateColor, 'var(--color-muted)')
  assert.equal(stale.stateDot, 'var(--color-muted)')
})

test('current totals never inherit historical answering counts from an older API', () => {
  const response = stats()
  const coverage = coverageFromStats(response)
  const landing = landingAggregateFromStats(response)
  assert.equal(coverage.answering, 3)
  assert.equal(coverage.awaitingRecheck, 12)
  assert.equal(landing.answeringAgents, 3)
  assert.equal(landing.byState.LIVE, 10)
  assert.equal(coverage.probed, 100)
  const zeroCurrent = {
    ...response,
    probed: { ...response.probed, currentByState: { LIVE: 0, DEGRADED: 0 } },
  }
  assert.deepEqual(landingAnsweringEvidence(landingAggregateFromStats(zeroCurrent)), {
    live: 0,
    degraded: 0,
    answering: 0,
  })
  const legacy = {
    ...response,
    probed: {
      agentsProbed: 100,
      byState: response.probed.byState,
      lastProbeSweepAt: response.probed.lastProbeSweepAt,
    },
  }
  assert.throws(() => coverageFromStats(legacy), /unavailable/)
  assert.throws(() => landingAggregateFromStats(legacy), /unavailable/)
  for (const value of [NaN, -1, 1.5, 101]) {
    assert.throws(() => coverageFromStats(stats(value)))
    assert.throws(() => landingAggregateFromStats(stats(value)))
  }
})

test('coverage refresh deduplicates, preserves measured data on failure, resumes on visibility and cleans up', async (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  const originalStats = api.stats
  let renderer: ReactTestRenderer | undefined
  const listeners = new Set<() => void>()
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }
  Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now })
  let calls = 0
  let fail = true
  let currentLive = 2
  const observed = new Map<string, RegistryCoverage>()
  api.stats = async () => {
    calls++
    if (fail) throw new Error('Temporary network failure')
    return stats(currentLive)
  }
  function Consumer({ id }: { id: string }) {
    const value = useRegistryCoverage()
    observed.set(id, value)
    return createElement('span', null, `${value.answering} ${value.freshness}`)
  }
  try {
    await act(async () => {
      renderer = create(
        createElement(
          Fragment,
          null,
          createElement(Consumer, { id: 'a' }),
          createElement(Consumer, { id: 'b' }),
        ),
      )
    })
    assert.equal(calls, 1)
    assert.equal(observed.get('a')?.freshness, 'cached')
    assert.equal(observed.get('b')?.freshness, 'cached')
    fail = false
    await act(async () => {
      t.mock.timers.tick(60_000)
    })
    assert.equal(calls, 2)
    assert.equal(observed.get('a')?.answering, 3)
    assert.equal(observed.get('a')?.freshness, 'live')
    fail = true
    await act(async () => {
      t.mock.timers.tick(60_000)
    })
    assert.equal(calls, 3)
    assert.equal(observed.get('a')?.answering, 3)
    assert.equal(observed.get('b')?.freshness, 'cached')
    documentStub.visibilityState = 'hidden'
    await act(async () => {
      t.mock.timers.tick(60_000)
    })
    assert.equal(calls, 3)
    fail = false
    currentLive = 0
    documentStub.visibilityState = 'visible'
    await act(async () => {
      for (const listener of listeners) listener()
    })
    assert.equal(calls, 4)
    assert.equal(observed.get('a')?.answering, 1)
    assert.equal(observed.get('b')?.freshness, 'live')
    await act(async () => renderer?.unmount())
    renderer = undefined
    assert.equal(listeners.size, 0)
    await act(async () => {
      t.mock.timers.tick(120_000)
    })
    assert.equal(calls, 4)
  } finally {
    await act(async () => renderer?.unmount())
    api.stats = originalStats
    t.mock.timers.reset()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  }
})

test('an open landing refreshes current counts and drops expired agent nodes without changing historical totals', async (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  const originals = { stats: api.stats, search: api.search }
  let renderer: ReactTestRenderer | undefined
  const listeners = new Set<() => void>()
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }
  Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now })
  let calls = 0
  let expired = false
  let observed: LandingMarketData | undefined
  const saved = passport(new Date(now - 86_400_000 + 30_000).toISOString())
  api.stats = async () => {
    calls++
    const response = stats()
    response.probed.currentByState = { LIVE: expired ? 0 : 1, DEGRADED: 0 }
    return response
  }
  // Even an older server/cache returning stale nodes must not keep them on the map.
  api.search = async () => ({ results: [saved], total: 1 }) as ProjectedSearchResponse
  function Consumer() {
    observed = useLandingMarketData()
    return createElement('output', null, observed.aggregate.answeringAgents)
  }
  try {
    await act(async () => {
      renderer = create(createElement(Consumer))
    })
    assert.equal(calls, 1)
    assert.equal(observed?.agents.length, 1)
    assert.equal(observed?.aggregate.answeringAgents, 1)
    expired = true
    await act(async () => {
      t.mock.timers.tick(30_001)
    })
    assert.equal(calls, 1)
    assert.equal(observed?.agents.length, 0)
    await act(async () => {
      t.mock.timers.tick(29_999)
    })
    assert.equal(calls, 2)
    assert.equal(observed?.agents.length, 0)
    assert.equal(observed?.aggregate.answeringAgents, 0)
    assert.equal(observed?.aggregate.byState.LIVE, 10)
    documentStub.visibilityState = 'hidden'
    await act(async () => {
      t.mock.timers.tick(60_000)
    })
    assert.equal(calls, 2)
    documentStub.visibilityState = 'visible'
    await act(async () => {
      for (const listener of listeners) listener()
    })
    assert.equal(calls, 3)
    await act(async () => renderer?.unmount())
    renderer = undefined
    assert.equal(listeners.size, 0)
    await act(async () => {
      t.mock.timers.tick(60_000)
    })
    assert.equal(calls, 3)
  } finally {
    await act(async () => renderer?.unmount())
    Object.assign(api, originals)
    t.mock.timers.reset()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  }
})

test('retained card data demotes at each exact expiry and after resuming a suspended tab', async (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  const listeners = new Set<() => void>()
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }
  Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  let renderer: ReactTestRenderer | undefined
  function Cards({ rows }: { rows: ProjectedPassport[] }) {
    useProbeExpiry(rows.map((row) => row.lastProbeAt))
    return createElement(
      'output',
      null,
      rows.map((row) => livenessPresentation(row.liveness, row.lastProbeAt).label).join('|'),
    )
  }
  function CrossedDuringCommit() {
    const row = passport(new Date(now - 86_400_000 + 1).toISOString())
    useProbeExpiry([row.lastProbeAt])
    useLayoutEffect(() => {
      t.mock.timers.setTime(now + 3)
    }, [])
    return createElement('output', null, livenessPresentation(row.liveness, row.lastProbeAt).label)
  }
  const rendered = () => JSON.stringify(renderer?.toJSON())
  try {
    const rows = [1000, 2000].map((remaining) =>
      passport(new Date(now - 86_400_000 + remaining).toISOString()),
    )
    await act(async () => {
      renderer = create(createElement(Cards, { rows }))
    })
    assert.match(rendered(), /Answering\|Answering/)
    await act(async () => {
      t.mock.timers.tick(1000)
    })
    assert.match(rendered(), /Answering\|Answering/)
    await act(async () => {
      t.mock.timers.tick(1)
    })
    assert.match(rendered(), /Last known: answering\|Answering/)
    await act(async () => {
      t.mock.timers.tick(1000)
    })
    assert.match(rendered(), /Last known: answering\|Last known: answering/)
    await act(async () => {
      renderer?.update(createElement(Cards, { rows: [passport(new Date().toISOString())] }))
    })
    assert.match(rendered(), /Answering/)
    documentStub.visibilityState = 'hidden'
    // Browser timers may be suspended. A visibility event must independently age the evidence.
    t.mock.timers.setTime(Date.now() + 86_400_001)
    documentStub.visibilityState = 'visible'
    await act(async () => {
      for (const listener of [...listeners]) listener()
    })
    assert.match(rendered(), /Last known: answering/)
    await act(async () => renderer?.unmount())
    renderer = undefined
    assert.equal(listeners.size, 0)
    t.mock.timers.setTime(now)
    await act(async () => {
      renderer = create(createElement(CrossedDuringCommit))
    })
    await act(async () => {
      t.mock.timers.tick(0)
    })
    assert.match(rendered(), /Last known: answering/)
  } finally {
    await act(async () => renderer?.unmount())
    t.mock.timers.reset()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  }
})
