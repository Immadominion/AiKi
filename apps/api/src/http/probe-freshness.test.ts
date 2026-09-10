import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryCreditStore } from '../credits/store.js'
import { InMemoryEvidenceStore } from '../evidence/store.js'
import * as guardedNetwork from '../net/guard.js'
import { createApiServer } from './server.js'

const now = Date.parse('2026-09-10T16:00:00.000Z')
const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

async function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const store = new InMemoryEvidenceStore()
  for (const [agentId, age] of [
    ['fresh', 1_000],
    ['boundary', 86_400_000],
    ['stale', 86_400_001],
    ['future', -1],
  ] as const) {
    const at = new Date(now - age).toISOString()
    const base = {
      subject: { type: 'agent' as const, chainId: 56, registry: '0x8004', agentId },
      observedAt: at,
      validAt: at,
      recordedAt: at,
      source: 'test',
      method: 'test',
      evidenceClass: 'B' as const,
    }
    await store.append({
      ...base,
      predicate: 'agent.liveness_verdict',
      value: { state: 'LIVE' },
      dedupeKey: `${agentId}:live`,
    })
    await store.append({
      ...base,
      predicate: 'erc8004.agent_registered',
      value: { owner: `0x${'12'.repeat(20)}` },
      dedupeKey: `${agentId}:identity`,
    })
    await store.append({
      ...base,
      predicate: 'erc8004.registration_resolution',
      value: {
        manifest: { name: agentId, services: [{ endpoint: 'https://example.test/readonly' }] },
      },
      dedupeKey: `${agentId}:manifest`,
    })
  }
  const noTaskAccess = vi.fn(async () => {
    throw new Error('No task or credit mutation is allowed.')
  })
  const app = createApiServer({
    observations: () => store.observations,
    tasks: {
      create: noTaskAccess,
      get: noTaskAccess,
      open: noTaskAccess,
      mine: noTaskAccess,
      claim: noTaskAccess,
      claimLapsedReview: noTaskAccess,
      submit: noTaskAccess,
      recordDelivery: noTaskAccess,
      noteDispatch: noTaskAccess,
      refundDeclinedAssignment: noTaskAccess,
      cancelLapsedClaim: noTaskAccess,
      advance: noTaskAccess,
    },
    assistant: { credits: new InMemoryCreditStore(), selfUrl: 'https://api.example' },
    publicUrl: 'https://api.example',
    deliverySecret: 'local-test-delivery-secret',
  })
  apps.push(app)
  return { app, store, noTaskAccess }
}

describe('API historical liveness and current-ready claims', () => {
  it('keeps the exact SQL-selected registry when an older same-id subject has more evidence', async () => {
    const { store } = await fixture()
    const template = store.observations.find(
      (o) => o.subject.agentId === 'fresh' && o.predicate === 'agent.liveness_verdict',
    )
    if (!template) throw new Error('Missing current fixture')
    const current = {
      ...template,
      subject: { ...template.subject, agentId: '42', registry: '0xfresh' },
    }
    const stale = {
      ...current,
      observedAt: new Date(now - 2 * 86_400_000).toISOString(),
      subject: { ...current.subject, registry: '0xhistorical' },
    }
    const app = createApiServer({
      observations: () => [],
      observationsForAgents: () => [current, stale, { ...stale, id: 'second-historical-row' }],
      searchAgents: async () => ({
        matches: [{ chainId: 56, registry: '0xfresh', agentId: '42', state: 'LIVE' }],
        total: 1,
        byState: { LIVE: 1 },
        currentByState: { LIVE: 1 },
        truncated: false,
      }),
    })
    apps.push(app)
    const response = (
      await app.inject({
        method: 'POST',
        url: '/v1/search',
        payload: { filters: { liveness: ['LIVE'] } },
      })
    ).json()
    expect(response.total).toBe(1)
    expect(response.results).toHaveLength(1)
    expect(response.results[0]).toMatchObject({
      agentId: '42',
      registry: '0xfresh',
      livenessFreshness: { state: 'LIVE' },
    })
  })
  it.each(['expired', 'changed-verdict'])(
    'rechecks a SQL match that is %s by projection time',
    async (mode) => {
      const { store } = await fixture()
      const template = store.observations.find(
        (o) => o.subject.agentId === 'fresh' && o.predicate === 'agent.liveness_verdict',
      )
      if (!template) throw new Error('Missing current fixture')
      const observation = {
        ...template,
        observedAt:
          mode === 'expired' ? new Date(now - 86_400_001).toISOString() : template.observedAt,
        value: { state: mode === 'changed-verdict' ? 'UNREACHABLE' : 'LIVE' },
      }
      const app = createApiServer({
        observations: () => [],
        observationsForAgents: () => [observation],
        searchAgents: async () => ({
          matches: [{ chainId: 56, registry: '0x8004', agentId: 'fresh', state: 'LIVE' }],
          total: 1,
          byState: { LIVE: 1 },
          currentByState: { LIVE: 1 },
          truncated: false,
        }),
      })
      apps.push(app)
      const response = (
        await app.inject({
          method: 'POST',
          url: '/v1/search',
          payload: { filters: { liveness: ['LIVE'] } },
        })
      ).json()
      expect(response.results).toEqual([])
      expect(response.total).toBe(0)
      expect(response.coverage.excludedUnverified).toBe(1)
    },
  )
  it('keeps stale passports and unfiltered browsing but excludes stale/future current-LIVE matches', async () => {
    const { app } = await fixture()
    const passport = (await app.inject('/v1/agents/stale/passport')).json()
    expect(passport).toMatchObject({
      liveness: 'LIVE',
      lastProbeAt: new Date(now - 86_400_001).toISOString(),
      livenessFreshness: { state: 'STALE' },
      checks: { successes: 1, trials: 1 },
    })
    const all = (await app.inject({ method: 'POST', url: '/v1/search', payload: {} })).json()
    expect(all.total).toBe(4)
    const filtered = (
      await app.inject({
        method: 'POST',
        url: '/v1/search',
        payload: { filters: { liveness: ['LIVE'] } },
      })
    ).json()
    expect(filtered.results.map((p: { agentId: string }) => p.agentId).sort()).toEqual([
      'boundary',
      'fresh',
    ])
    expect(filtered.coverage).toMatchObject({
      excludedUnverified: 2,
      exclusionReasons: { LIVE: 2 },
    })
    expect((await app.inject('/v1/stats')).json().probed).toMatchObject({
      byState: { LIVE: 4 },
      currentByState: { LIVE: 2 },
      staleAgents: 2,
    })
  })
  it.each(['stale', 'future'])(
    'refuses a %s quote without erasing the historical LIVE verdict',
    async (agentId) => {
      const { app } = await fixture()
      const response = await app.inject({ method: 'POST', url: '/v1/quotes', payload: { agentId } })
      expect(response.statusCode).toBe(422)
      expect(response.json().error).toMatchObject({
        code: 'AGENT_NOT_QUOTABLE',
        message: expect.stringContaining('current LIVE probe'),
      })
      expect((await app.inject(`/v1/agents/${agentId}/passport`)).json().liveness).toBe('LIVE')
    },
  )
  it('requires current evidence before advertising task delivery and never checks stale providers', async () => {
    const { app, noTaskAccess } = await fixture()
    const read = vi
      .spyOn(guardedNetwork, 'guardedFetch')
      .mockResolvedValue(Response.json({ taskProtocol: 'aiki.task/v1' }))
    expect((await app.inject('/v1/agents/stale/task-support')).json()).toMatchObject({
      available: false,
    })
    expect((await app.inject('/v1/agents/future/task-support')).json()).toMatchObject({
      available: false,
    })
    expect(read).not.toHaveBeenCalled()
    expect((await app.inject('/v1/agents/fresh/task-support')).json()).toMatchObject({
      available: true,
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(noTaskAccess).not.toHaveBeenCalled()
  })
})
