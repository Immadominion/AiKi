import { describe, expect, it } from 'vitest'
import { InMemoryEvidenceStore, materializeObservation } from './store.js'

/*
 * A test that returns early is reported as PASSING. Six database tests here
 * did exactly that, so the suite claimed to have verified the evidence store
 * on every machine that had no DATABASE_URL, including CI. Skip loudly instead:
 * an unrun check must never read as a green one.
 */
const databaseUrl = process.env.DATABASE_URL

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

it.skipIf(!databaseUrl)(
  'reads a block number back as a number, not the string BIGINT returns',
  async () => {
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
      /*
       * Read by agent, not off the page.
       *
       * This asked `list()` for the newest ten thousand rows and then looked for
       * one row dated 2026-01-01 in them. Against an empty test database that
       * works and proves the BIGINT point. Against a copy of production it fails,
       * because the fixture sorts last and never appears. It is the same window that
       * made search unable to find LIVE agents, reproducing inside the test that
       * was supposed to be checking the store.
       */
      const row = (await store.observationsForAgents(['bigint-check'])).find(
        (o) => o.subject.agentId === 'bigint-check',
      )
      // Every projection tests typeof === 'number'. A string here means a real
      // block reads as no block, which is how lastIndexedBlock stayed 0 in
      // production while the indexer was working.
      expect(typeof row?.blockNumber).toBe('number')
      expect(row?.blockNumber).toBe(block)
    } finally {
      await store.close()
    }
  },
)

it.skipIf(!databaseUrl)(
  'resumes from a number, so the next block is addition and not concatenation',
  async () => {
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
  },
)

it.skipIf(!databaseUrl)(
  'probes the newest registration first among agents nothing has ever probed',
  async () => {
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
      /*
       * Blocks above any real BSC height, so these three head the unprobed queue
       * whatever else the database holds. With small numbers the fixtures sorted
       * behind fifteen thousand genuinely-registered agents and never appeared in
       * the page at all: the test passed only because the table was empty, which
       * is the assumption that let the search window bug reach production.
       */
      for (const [agentId, block] of [
        ['middle', 999_000_200],
        ['newest', 999_000_300],
        ['oldest', 999_000_100],
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
  },
)

it.skipIf(!databaseUrl)(
  'counts the dashboard over every row, and agrees with the in-memory fold',
  async () => {
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
  },
)

it.skipIf(!databaseUrl)(
  'selects agents by their latest verdict, however old their rows are',
  async () => {
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
  },
)

/*
 * The regression test for the defect this file's own window caused.
 *
 * An agent's identity is ONE row and its work is thousands, so on any store
 * ordered by time the identity is what ages out first. Measured on production:
 * the Venus guardian had 102 rows inside the newest-ten-thousand page and every
 * one of them was telemetry, so it projected as nameless and UNPROBED and
 * search could not return it while its own passport called it LIVE.
 *
 * The scale is simulated with a small explicit limit rather than ten thousand
 * inserts, because the number is not the point: the point is that a reader that
 * windows on ROWS loses agents, and one that selects AGENTS does not.
 */
it.skipIf(!databaseUrl)(
  'finds a busy agent whose own output has aged its identity out',
  async () => {
    const url = process.env.DATABASE_URL
    if (!url) return
    const { PostgresEvidenceStore } = await import('./postgres-store.js')
    const store = new PostgresEvidenceStore(url)
    const registry = `0xwindow-${Date.now()}`
    const agentId = `window-${Date.now()}`
    // Unique for the same reason: this fixture must not have to outrank the
    // real registry to prove a point about windows.
    const term = `sentinel${Date.now()}`
    const subject = { type: 'agent' as const, chainId: 56, registry, agentId }
    const base = {
      subject,
      source: 'test',
      method: 'test',
      evidenceClass: 'B' as const,
    }
    try {
      /*
       * The chain event first. The catalogue is built from agents the registry
       * told us about, so an agent carrying observations but no registration is
       * not a listing at all. This fixture only passed while search read
       * whichever rows happened to exist.
       */
      await store.append({
        ...base,
        predicate: 'erc8004.agent_registered',
        value: { owner: '0x1', agentURI: 'https://x/1.json' },
        validAt: '2026-01-01T00:00:00.000Z',
        observedAt: '2026-01-01T00:00:00.000Z',
        dedupeKey: `${agentId}:registered`,
      })
      // Its identity and its verdict, written once and long ago.
      await store.append({
        ...base,
        predicate: 'erc8004.registration_resolution',
        value: {
          manifest: {
            name: `Test ${term} Guardian`,
            description: `Watches lending positions and reports ${term} liquidation risk.`,
            services: [{ name: 'venus-health-factor-assessment', endpoint: 'https://x/1' }],
          },
        },
        validAt: '2026-01-01T00:00:00.000Z',
        observedAt: '2026-01-01T00:00:00.000Z',
        dedupeKey: `${agentId}:registration`,
      })
      await store.append({
        ...base,
        predicate: 'agent.liveness_verdict',
        value: { state: 'LIVE' },
        validAt: '2026-01-01T00:00:01.000Z',
        observedAt: '2026-01-01T00:00:01.000Z',
        dedupeKey: `${agentId}:verdict`,
      })
      // Its work, written continuously and recently.
      for (let n = 0; n < 8; n += 1) {
        await store.append({
          ...base,
          predicate: 'venus.health_factor_assessment',
          value: { healthFactor: '1.42' },
          validAt: `2026-09-01T00:00:0${n}.000Z`,
          observedAt: `2026-09-01T00:00:0${n}.000Z`,
          dedupeKey: `${agentId}:work:${n}`,
        })
      }

      // The window loses it: the newest eight rows of this agent are all telemetry,
      // so nothing in the page says what it is called or that it answers.
      const page = await store.list(8)
      const identityInPage = page.filter(
        (o) =>
          o.subject.agentId === agentId &&
          (o.predicate === 'erc8004.registration_resolution' ||
            o.predicate === 'agent.liveness_verdict'),
      )
      expect(identityInPage).toHaveLength(0)

      // Selecting agents does not. Both readers must still see it whole.
      const byName = await store.searchAgents({
        tsquery: term,
        states: ['LIVE'],
        limit: 20,
      })
      expect(byName.matches.map((m) => m.agentId)).toContain(agentId)

      const byLiveness = await store.observationsForLiveness(['LIVE'])
      expect(byLiveness.some((o) => o.subject.agentId === agentId)).toBe(true)

      // And it is findable by what it DOES, not only by what it is called.
      const byCapability = await store.searchAgents({
        tsquery: `${term} | liquidation`,
        states: ['LIVE'],
        limit: 20,
      })
      expect(byCapability.matches.map((m) => m.agentId)).toContain(agentId)
    } finally {
      await store.close()
    }
  },
)

/*
 * The catalogue is the registry, not our opinion of it.
 *
 * Search used to default to LIVE and DEGRADED and DROP the rest, which listed
 * 243 agents out of more than sixteen thousand indexed. No marketplace
 * personally uses every item it lists, and gating the listing on our own probe
 * made the catalogue a tenth of a percent of the chain, and the product
 * unfinishable: complete only once we had probed everything.
 *
 * Evidence ranks now. Everything is listed, the best-evidenced first, and every
 * row carries the state so it can say what it is.
 */
it.skipIf(!databaseUrl)(
  'lists agents it has never probed, and ranks them below ones it has',
  async () => {
    const url = process.env.DATABASE_URL
    if (!url) return
    const { PostgresEvidenceStore } = await import('./postgres-store.js')
    const store = new PostgresEvidenceStore(url)
    const registry = `0xcatalogue-${Date.now()}`
    const stamp = Date.now()
    /*
     * A term unique to this run.
     *
     * Searching a word every previous run also used meant fifty-four fixtures
     * competed for one page and the newest lost: the test passed on an empty
     * database and failed once enough runs had piled up. A test whose result
     * depends on how many times it has been run is not a test.
     */
    const term = `beacon${stamp}`
    const subject = (agentId: string) => ({
      type: 'agent' as const,
      chainId: 56,
      registry,
      agentId,
    })
    const at = '2026-01-01T00:00:00.000Z'
    try {
      // Three agents that all say "beacon": one answering, one never probed, one
      // caught serving the same bytes to every input.
      for (const [suffix, state] of [
        ['answering', 'LIVE'],
        ['unprobed', null],
        ['fake', 'IMPOSTOR_STATIC'],
      ] as const) {
        const agentId = `cat-${suffix}-${stamp}`
        await store.append({
          subject: subject(agentId),
          predicate: 'erc8004.agent_registered',
          value: { owner: '0x1', agentURI: 'https://x/a.json' },
          validAt: at,
          observedAt: at,
          source: 'test',
          method: 'test',
          evidenceClass: 'A',
          dedupeKey: `${agentId}:registered`,
        })
        await store.append({
          subject: subject(agentId),
          predicate: 'erc8004.registration_resolution',
          value: { manifest: { name: `${term} ${suffix}`, description: `A ${term} agent.` } },
          validAt: at,
          observedAt: at,
          source: 'test',
          method: 'test',
          evidenceClass: 'B',
          dedupeKey: `${agentId}:registration`,
        })
        if (state)
          await store.append({
            subject: subject(agentId),
            predicate: 'agent.liveness_verdict',
            value: { state },
            validAt: at,
            observedAt: at,
            source: 'test',
            method: 'test',
            evidenceClass: 'B',
            dedupeKey: `${agentId}:verdict`,
          })
      }

      const found = await store.searchAgents({ tsquery: term, states: null, limit: 50 })
      const mine = found.matches.filter((m) => m.agentId.endsWith(String(stamp)))

      // All three are listed. The unprobed one is a real listing with an honest
      // label, and the impostor is listed so the page can say what it is.
      expect(mine).toHaveLength(3)
      expect(mine.map((m) => m.state)).toEqual(['LIVE', 'UNPROBED', 'IMPOSTOR_STATIC'])

      // The state travels with the row, because a listing nobody can label is a
      // listing nobody can judge.
      expect(found.byState.LIVE).toBeGreaterThanOrEqual(1)
      expect(found.byState.IMPOSTOR_STATIC).toBeGreaterThanOrEqual(1)

      // A caller may still ask for a filter; it is just not the default.
      const onlyLive = await store.searchAgents({ tsquery: term, states: ['LIVE'], limit: 50 })
      expect(onlyLive.matches.filter((m) => m.agentId.endsWith(String(stamp)))).toHaveLength(1)
    } finally {
      await store.close()
    }
  },
)
