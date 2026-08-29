import { describe, expect, it } from 'vitest'
import { InMemoryEvidenceStore, materializeObservation } from './store.js'

const input = {
  subject: {
    type: 'agent' as const,
    chainId: 56,
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    agentId: '1',
  },
  predicate: 'erc8004.agent_registered',
  value: { owner: '0xabc' },
  validAt: '2026-08-20T10:00:00.000Z',
  observedAt: '2026-08-20T10:00:01.000Z',
  source: 'chain:bsc',
  method: 'erc8004:Registered/v1',
  evidenceClass: 'A' as const,
  finality: 'finalized' as const,
  dedupeKey: 'chain:56:tx:0',
}
describe('evidence store', () => {
  it('is idempotent by source-derived dedupe key', async () => {
    const store = new InMemoryEvidenceStore()
    expect((await store.append(input)).inserted).toBe(true)
    expect((await store.append(input)).inserted).toBe(false)
    expect(store.observations).toHaveLength(1)
  })
  it('rejects facts recorded before they were observed', () => {
    expect(() =>
      materializeObservation({ ...input, recordedAt: '2026-08-20T09:59:59.000Z' }),
    ).toThrow('recordedAt cannot precede observedAt')
  })
})

it('reads a block number back as a number, not the string BIGINT returns', async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  const { PostgresEvidenceStore } = await import('./postgres-store.js')
  const store = new PostgresEvidenceStore(url)
  try {
    const block = 118_463_582
    await store.append({
      subject: { type: 'agent', chainId: 56, registry: '0xbig', agentId: 'bigint-check' },
      predicate: 'erc8004.agent_registered',
      value: { owner: '0x1', agentURI: 'https://x' },
      validAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:00.000Z',
      source: 'test',
      method: 'test',
      evidenceClass: 'A',
      blockNumber: block,
      dedupeKey: 'bigint-check',
    })
    const row = (await store.list()).find((o) => o.subject.agentId === 'bigint-check')
    // Every projection tests typeof === 'number'. A string here means a real
    // block reads as no block, which is how lastIndexedBlock stayed 0 in
    // production while the indexer was working.
    expect(typeof row?.blockNumber).toBe('number')
    expect(row?.blockNumber).toBe(block)
  } finally {
    await store.close()
  }
})

it('resumes from a number, so the next block is addition and not concatenation', async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  const { PostgresEvidenceStore } = await import('./postgres-store.js')
  const store = new PostgresEvidenceStore(url)
  try {
    const stream = `checkpoint-type-${Date.now()}`
    await store.saveCheckpoint({
      stream,
      lastIndexedBlock: 118_464_140,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const back = await store.getCheckpoint(stream)
    expect(typeof back?.lastIndexedBlock).toBe('number')
    // The bug this exists for: a string checkpoint made the next block
    // 1184641401, past the chain head, so the indexer did nothing and said it
    // had succeeded.
    expect((back?.lastIndexedBlock ?? 0) + 1).toBe(118_464_141)
  } finally {
    await store.close()
  }
})

it('probes the newest registration first among agents nothing has ever probed', async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  const { PostgresEvidenceStore } = await import('./postgres-store.js')
  const store = new PostgresEvidenceStore(url)
  const registry = `0xorder-${Date.now()}`
  try {
    // Inserted oldest-block LAST, so heap order and registration order disagree.
    // Without an explicit tiebreak the plan tends to return insertion order and
    // the newest agent — the one a user is most likely to be asking about — waits
    // behind every agent that has ever gone unprobed.
    for (const [agentId, block] of [
      ['middle', 200],
      ['newest', 300],
      ['oldest', 100],
    ] as const) {
      await store.append({
        subject: { type: 'agent', chainId: 56, registry, agentId },
        predicate: 'erc8004.agent_registered',
        value: { owner: '0x1', agentURI: `https://example.test/${agentId}.json` },
        validAt: '2026-01-01T00:00:00.000Z',
        observedAt: '2026-01-01T00:00:00.000Z',
        source: 'test',
        method: 'test',
        evidenceClass: 'A',
        blockNumber: block,
        dedupeKey: `${registry}-${agentId}`,
      })
    }
    const due = (await store.dueForProbe(500, 24)).filter((r) => r.registry_address === registry)
    expect(due.map((r) => r.agent_id)).toEqual(['newest', 'middle', 'oldest'])
  } finally {
    await store.close()
  }
})

it('counts the dashboard over every row, and agrees with the in-memory fold', async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  const { PostgresEvidenceStore } = await import('./postgres-store.js')
  const { aggregateStats } = await import('../projections/stats.js')
  const store = new PostgresEvidenceStore(url)
  const registry = `0xstats-${Date.now()}`
  try {
    const at = (n: number) => `2026-02-0${n}T00:00:00.000Z`
    for (const [agentId, block] of [
      ['a', 10],
      ['b', 20],
      ['c', 30],
    ] as const) {
      await store.append({
        subject: { type: 'agent', chainId: 56, registry, agentId },
        predicate: 'erc8004.agent_registered',
        value: { owner: '0x1', agentURI: `https://example.test/${agentId}.json` },
        validAt: at(1),
        observedAt: at(1),
        source: 'test',
        method: 'test',
        evidenceClass: 'A',
        blockNumber: block,
        dedupeKey: `${registry}-reg-${agentId}`,
      })
    }
    // Agent 'a' is probed twice. Only its LATEST verdict may be counted, and the
    // superseded one must not inflate agentsProbed.
    for (const [agentId, state, day] of [
      ['a', 'UNREACHABLE', 2],
      ['a', 'LIVE', 3],
      ['b', 'IMPOSTOR_STATIC', 2],
    ] as const) {
      await store.append({
        subject: { type: 'agent', chainId: 56, registry, agentId },
        predicate: 'agent.liveness_verdict',
        value: { state },
        validAt: at(day),
        observedAt: at(day),
        source: 'test',
        method: 'test',
        evidenceClass: 'B',
        dedupeKey: `${registry}-probe-${agentId}-${day}`,
      })
    }

    // Both sides read the SAME store, so they must produce the same answer. The
    // in-memory side is given an explicit limit far above the row count; the
    // default is 10,000 and reading the dashboard through it is the bug.
    const fromSql = await store.statsAggregate()
    const everything = await store.list(1_000_000)
    const inMemory = aggregateStats(everything)
    expect(fromSql).toEqual(inMemory)

    // And the whole store must actually be big enough for the cap to bite,
    // otherwise this test would pass on a store where the bug cannot appear.
    expect(everything.length).toBeGreaterThan(0)
    const scoped = aggregateStats(everything.filter((o) => o.subject.registry === registry))
    expect(scoped.probed.agentsProbed).toBe(2)
    expect(scoped.probed.byRawState).toEqual({ LIVE: 1, IMPOSTOR_STATIC: 1 })
    expect(scoped.indexed.firstIndexedBlock).toBe(10)
    expect(scoped.indexed.lastIndexedBlock).toBe(30)
  } finally {
    await store.close()
  }
})

it('selects agents by their latest verdict, however old their rows are', async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  const { PostgresEvidenceStore } = await import('./postgres-store.js')
  const store = new PostgresEvidenceStore(url)
  const registry = `0xliveness-${Date.now()}`
  const subject = (agentId: string) => ({
    type: 'agent' as const,
    chainId: 56,
    registry,
    agentId,
  })
  const verdict = (agentId: string, state: string, observedAt: string) => ({
    subject: subject(agentId),
    predicate: 'agent.liveness_verdict',
    value: { state },
    validAt: observedAt,
    observedAt,
    source: 'prober',
    method: 'probe/v1',
    evidenceClass: 'B' as const,
    dedupeKey: `${registry}:${agentId}:${state}:${observedAt}`,
  })
  try {
    // Probed long ago and never since. This is the agent the capped read model
    // loses first, and losing it is what made production report four live
    // agents while the aggregate counted thirteen.
    await store.append(verdict('ancient', 'LIVE', '2020-01-01T00:00:00.000Z'))
    await store.append({
      subject: subject('ancient'),
      predicate: 'erc8004.agent_registered',
      value: { agentURI: 'https://example.com/ancient' },
      validAt: '2019-01-01T00:00:00.000Z',
      observedAt: '2019-01-01T00:00:00.000Z',
      source: 'chain:bsc',
      method: 'erc8004:Registered/v1',
      evidenceClass: 'A' as const,
      dedupeKey: `${registry}:ancient:registered`,
    })
    // Was live, is not any more. Only the latest verdict may decide.
    await store.append(verdict('lapsed', 'LIVE', '2020-01-01T00:00:00.000Z'))
    await store.append(verdict('lapsed', 'DECLARED_ONLY', '2026-08-01T00:00:00.000Z'))
    // Never live, probed most recently of the three.
    await store.append(verdict('dead', 'IMPOSTOR_STATIC', '2026-08-02T00:00:00.000Z'))

    const live = await store.observationsForLiveness(['LIVE'])
    const mine = live.filter((o) => o.subject.registry.toLowerCase() === registry.toLowerCase())
    const agents = [...new Set(mine.map((o) => o.subject.agentId))].sort()

    expect(agents).toEqual(['ancient'])
    // Whole agent or no agent: the registration comes back with the verdict, so
    // a passport projected from this is never half-remembered.
    expect(mine.map((o) => o.predicate).sort()).toEqual([
      'agent.liveness_verdict',
      'erc8004.agent_registered',
    ])
  } finally {
    await store.close()
  }
})
