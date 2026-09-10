import { hasCurrentLiveness, PROBE_FRESHNESS_MAX_AGE_MS, probeFreshness } from '@aiki/contracts'
import { describe, expect, it } from 'vitest'
import { materializeObservation } from '../evidence/store.js'
import { projectPassport } from './passport.js'
import { aggregateStats, assembleStats } from './stats.js'

const now = Date.parse('2026-09-10T16:00:00.000Z')
const at = (age: number) => new Date(now - age).toISOString()
const ttl = PROBE_FRESHNESS_MAX_AGE_MS
const verdict = (id: string, state: string, timestamp: string) =>
  materializeObservation({
    subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: id },
    predicate: 'agent.liveness_verdict',
    value: { state },
    observedAt: timestamp,
    validAt: timestamp,
    recordedAt: timestamp,
    source: 'test',
    method: 'test',
    evidenceClass: 'B',
    dedupeKey: `${id}:${state}:${timestamp}`,
  })

describe('historical probe evidence and current availability', () => {
  it.each([0, ttl - 1, ttl])('accepts evidence aged %i milliseconds', (age) => {
    expect(probeFreshness(at(age), now)).toEqual({
      state: 'LIVE',
      checkedAt: at(age),
      ageMs: age,
      expiresAt: new Date(now - age + ttl).toISOString(),
    })
    expect(hasCurrentLiveness({ liveness: 'LIVE', lastProbeAt: at(age) }, ['LIVE'], now)).toBe(true)
  })
  it.each([ttl + 1, ttl * 9])('marks evidence aged %i milliseconds as last known', (age) => {
    expect(probeFreshness(at(age), now).state).toBe('STALE')
    expect(hasCurrentLiveness({ liveness: 'LIVE', lastProbeAt: at(age) }, ['LIVE'], now)).toBe(
      false,
    )
  })
  it.each([undefined, null, '', 'not-a-date', at(-1)])(
    'does not accept timestamp %s',
    (lastProbeAt) => {
      expect(hasCurrentLiveness({ liveness: 'LIVE', lastProbeAt }, ['LIVE'], now)).toBe(false)
      expect(probeFreshness(lastProbeAt, now).state).toBe(lastProbeAt == null ? 'NO_DATA' : 'STALE')
    },
  )
  it('requires an allowed verdict independently of freshness and recomputes cached flags', () => {
    expect(hasCurrentLiveness({ liveness: 'DEGRADED', lastProbeAt: at(0) }, ['LIVE'], now)).toBe(
      false,
    )
    expect(
      hasCurrentLiveness({ liveness: 'DEGRADED', lastProbeAt: at(0) }, ['LIVE', 'DEGRADED'], now),
    ).toBe(true)
    expect(hasCurrentLiveness({ liveness: 'LIVE', lastProbeAt: at(ttl) }, ['LIVE'], now + 1)).toBe(
      false,
    )
  })
  it('preserves historical state, timestamps, checks and scores when freshness expires', () => {
    const rows = [verdict('7', 'LIVE', at(0))]
    const fresh = projectPassport('7', rows, now)
    const stale = projectPassport('7', rows, now + ttl + 1)
    expect(stale).toEqual({ ...fresh, livenessFreshness: probeFreshness(at(0), now + ttl + 1) })
    expect(stale.liveness).toBe('LIVE')
    expect(stale.lastProbeAt).toBe(at(0))
    expect(stale.checks).toEqual({ successes: 1, trials: 1 })
  })
  it('counts current separately from historical verdicts, including future timestamps', () => {
    const rows = [
      verdict('fresh', 'LIVE', at(ttl)),
      verdict('stale', 'LIVE', at(ttl + 1)),
      verdict('future', 'LIVE', at(-1)),
      verdict('degraded', 'DEGRADED', at(0)),
    ]
    const stats = assembleStats(aggregateStats(rows, now))
    expect(stats.probed).toMatchObject({
      agentsProbed: 4,
      byState: { LIVE: 3, DEGRADED: 1 },
      currentByState: { LIVE: 1, DEGRADED: 1 },
      staleAgents: 2,
    })
  })
  it('fails closed when an older aggregate omits current evidence counts', () => {
    const aggregate = aggregateStats([verdict('fresh', 'LIVE', at(0))], now)
    delete aggregate.probed.currentByRawState
    delete aggregate.probed.staleAgents
    expect(assembleStats(aggregate).probed).toMatchObject({
      byState: { LIVE: 1 },
      currentByState: {},
      staleAgents: 1,
    })
  })
})
