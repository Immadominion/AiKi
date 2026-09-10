import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { runProbeSweep } from '../prober/sweep.js'
import { aggregateStats } from '../projections/stats.js'
import { PostgresEvidenceStore } from './postgres-store.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Probe fairness regressions require a loopback-only test database.')

describe.skipIf(!databaseUrl)(
  'fair probe queue and current evidence in isolated PostgreSQL',
  () => {
    const schema = `probe_fairness_${randomUUID().replaceAll('-', '')}`
    let admin: postgres.Sql, sql: postgres.Sql, store: PostgresEvidenceStore
    beforeAll(async () => {
      if (!databaseUrl) throw new Error('Missing local test database')
      admin = postgres(databaseUrl, { max: 1, onnotice: () => {} })
      await admin`CREATE SCHEMA ${admin(schema)}`
      const scoped = new URL(databaseUrl)
      scoped.searchParams.set('search_path', schema)
      sql = postgres(scoped.toString(), { max: 1, onnotice: () => {} })
      expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
      await applyMigrations(
        sql,
        await readMigrations(new URL('../db/migrations/', import.meta.url)),
        () => {},
      )
      store = new PostgresEvidenceStore(scoped.toString())
    }, 30_000)
    beforeEach(async () => {
      await sql`TRUNCATE observations`
    })
    afterAll(async () => {
      await store?.close()
      await sql?.end()
      if (admin) {
        await admin`DROP SCHEMA ${admin(schema)} CASCADE`
        await admin.end()
      }
    })

    async function seed(
      id: string,
      state?: string,
      opts: { chainId?: number; registry?: string; block?: number; age?: number } = {},
    ) {
      const registeredAt = new Date(Date.now() - 10 * 86_400_000).toISOString()
      const subject = {
        type: 'agent' as const,
        chainId: opts.chainId ?? 56,
        registry: opts.registry ?? '0x8004',
        agentId: id,
      }
      const base = { subject, source: 'test', method: 'test', evidenceClass: 'B' as const }
      const key = `${subject.chainId}:${subject.registry}:${id}`
      await store.append({
        ...base,
        predicate: 'erc8004.agent_registered',
        value: { agentURI: `https://example.test/${id}`, owner: '0x1' },
        observedAt: registeredAt,
        validAt: registeredAt,
        recordedAt: registeredAt,
        blockNumber: opts.block ?? 1,
        dedupeKey: `${key}:registration`,
      })
      await store.append({
        ...base,
        predicate: 'erc8004.registration_resolution',
        value: { manifest: { name: `Agent ${id}`, description: 'yield research' } },
        observedAt: registeredAt,
        validAt: registeredAt,
        recordedAt: registeredAt,
        dedupeKey: `${key}:manifest`,
      })
      if (state) {
        const probedAt = new Date(Date.now() - (opts.age ?? 2 * 86_400_000)).toISOString()
        await store.append({
          ...base,
          predicate: 'agent.liveness_verdict',
          value: { state },
          observedAt: probedAt,
          validAt: probedAt,
          recordedAt: probedAt,
          dedupeKey: `${key}:verdict`,
        })
      }
    }

    it('reserves 10 LIVE, 10 other rechecks and 20 discoveries despite a persistent new backlog', async () => {
      for (let i = 0; i < 50; i++) {
        await seed(`live${i}`, 'LIVE')
        await seed(`stale${i}`, 'UNREACHABLE')
        await seed(`new${i}`, undefined, { block: 1_000 + i })
      }
      for (let pass = 0; pass < 2; pass++) {
        const due = await store.dueForProbe(40, 24)
        expect(due).toHaveLength(40)
        expect(due.filter((r) => r.agent_id.startsWith('live'))).toHaveLength(10)
        expect(due.filter((r) => r.agent_id.startsWith('stale'))).toHaveLength(10)
        expect(due.filter((r) => r.agent_id.startsWith('new'))).toHaveLength(20)
        // The budgeted sweep consumes this order, so the first concurrency-sized
        // prefix must not consist solely of rechecks.
        expect(
          due.slice(0, 4).map((r) => r.agent_id.replace(/^(live|stale|new).*$/, '$1')),
        ).toEqual(['live', 'stale', 'new', 'new'])
        let clock = 0
        const started: string[] = []
        const bounded = await runProbeSweep(
          due.map((row) => ({
            agentId: row.agent_id,
            chainId: row.chain_id,
            registry: row.registry_address,
            agentUri: row.agent_uri,
            lastProbedAt: null,
          })),
          async (candidate) => {
            started.push(candidate.agentId.replace(/^(live|stale|new).*$/, '$1'))
            await Promise.resolve()
            clock = 10
            return 0
          },
          { concurrency: 4, budgetMs: 10, now: () => clock },
        )
        expect(started).toEqual(['live', 'stale', 'new', 'new'])
        expect(bounded).toMatchObject({ probed: 4, skipped: 36, failed: 0 })
        for (const row of due) {
          const at = new Date().toISOString()
          await store.append({
            subject: {
              type: 'agent',
              chainId: row.chain_id,
              registry: row.registry_address,
              agentId: row.agent_id,
            },
            predicate: 'agent.liveness_verdict',
            value: { state: 'LIVE' },
            observedAt: at,
            validAt: at,
            recordedAt: at,
            source: 'test',
            method: 'test',
            evidenceClass: 'B',
            dedupeKey: `pass:${pass}:${row.agent_id}`,
          })
        }
        for (let i = 0; i < 30; i++)
          await seed(`new-pass${pass}-${i}`, undefined, { block: 2_000 + pass * 100 + i })
      }
    })
    it('borrows unused lane capacity and keeps newest discoveries first', async () => {
      await seed('live', 'LIVE')
      for (let i = 0; i < 45; i++) await seed(`new${i}`, undefined, { block: i })
      const due = await store.dueForProbe(40, 24)
      expect(due).toHaveLength(40)
      expect(due.some((r) => r.agent_id === 'live')).toBe(true)
      expect(due.filter((r) => r.agent_id.startsWith('new')).map((r) => r.agent_id)).toEqual(
        Array.from({ length: 39 }, (_, i) => `new${44 - i}`),
      )
    })
    it('never borrows more than a small requested limit and returns useful work from any lane', async () => {
      await seed('new')
      expect((await store.dueForProbe(1, 24)).map((r) => r.agent_id)).toEqual(['new'])
      await seed('stale', 'DEGRADED')
      await seed('live', 'LIVE')
      expect(await store.dueForProbe(1, 24)).toHaveLength(1)
      expect(await store.dueForProbe(2, 24)).toHaveLength(2)
      expect(await store.dueForProbe(3, 24)).toHaveLength(3)
      const rotations = []
      for (let phase = 0; phase < 3; phase++)
        rotations.push((await store.dueForProbe(1, 24, phase * 1_800_000))[0]?.agent_id)
      expect(rotations).toEqual(['live', 'stale', 'new'])
    })
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001])(
      'rejects unsafe limit %s',
      async (limit) => {
        await expect(store.dueForProbe(limit, 24)).rejects.toThrow('Probe limit')
      },
    )
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 8761])(
      'rejects unsafe stale interval %s',
      async (hours) => {
        await expect(store.dueForProbe(40, hours)).rejects.toThrow('Probe stale interval')
      },
    )
    it('joins full subjects, normalizes registry case and excludes fresh verdicts', async () => {
      await seed('same', 'LIVE', { registry: '0xABCD', age: 1_000 })
      await seed('same', undefined, { registry: '0x1234' })
      await seed('same', undefined, { registry: '0xabcd', chainId: 97 })
      const due = await store.dueForProbe(40, 24)
      expect(due.map((r) => `${r.chain_id}:${r.registry_address}:${r.agent_id}`).sort()).toEqual([
        '56:0x1234:same',
        '97:0xabcd:same',
      ])
    })
    it('returns malformed future evidence for recheck rather than treating it as indefinitely fresh', async () => {
      await seed('future', 'LIVE', { age: -86_400_000 })
      expect((await store.dueForProbe(40, 24)).map((r) => r.agent_id)).toEqual(['future'])
    })
    it('keeps historical browse/counts but filters current LIVE and DEGRADED consistently', async () => {
      await seed('old-live', 'LIVE')
      await seed('fresh-live', 'LIVE', { age: 1_000 })
      await seed('fresh-degraded', 'DEGRADED', { age: 1_000 })
      await seed('future-live', 'LIVE', { age: -86_400_000 })
      await seed('new')
      const now = Date.now()
      const all = await store.searchAgents({ tsquery: null, states: null, limit: 100 }, now)
      expect(all.total).toBe(5)
      expect(all.byState).toEqual({ LIVE: 3, DEGRADED: 1, UNPROBED: 1 })
      expect(all.currentByState).toEqual({ LIVE: 1, DEGRADED: 1 })
      const filtered = await store.searchAgents(
        { tsquery: null, states: ['LIVE', 'DEGRADED'], limit: 100 },
        now,
      )
      expect(filtered.matches.map((r) => r.agentId)).toEqual(['fresh-live', 'fresh-degraded'])
      const rows = await store.observationsForLiveness(['LIVE', 'DEGRADED'], 100, now)
      expect([...new Set(rows.map((r) => r.subject.agentId))].sort()).toEqual([
        'fresh-degraded',
        'fresh-live',
      ])
      const aggregate = await store.statsAggregate(now)
      expect(aggregate).toEqual(aggregateStats(await store.list(), now))
      expect(aggregate.probed).toMatchObject({
        byRawState: { LIVE: 3, DEGRADED: 1 },
        currentByRawState: { LIVE: 1, DEGRADED: 1 },
        staleAgents: 2,
      })
      expect(aggregate.categories.yield_optimisation).toEqual({ agents: 5, live: 1 })
    })
  },
)
