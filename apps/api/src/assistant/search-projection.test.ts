import { expect, it, vi } from 'vitest'
import { runTool } from './tools.js'

/**
 * What a search costs the model that reads it.
 *
 * Measured on production: eight passports is 19,349 characters, which is the
 * whole per-result cap. A turn that searched, read the catalogue and checked one
 * agent cost 1,588 points and stopped against a 2,000 point ceiling before it
 * could hire anything, having spent that budget carrying predicate counts, an
 * icon url and a component breakdown of four nulls.
 */

const ctx = { baseUrl: 'https://api.example', cookie: 'c', sessionAddress: `0x${'11'.repeat(20)}` }

const row = (id: string) => ({
  agentId: id,
  chainId: 56,
  name: `Agent ${id}`,
  description: 'Does a thing.',
  liveness: 'LIVE',
  livenessDetail: 'Answered every check.',
  livenessFreshness: {
    state: 'LIVE',
    checkedAt: '2026-09-12T17:17:12.902Z',
    ageMs: 7,
    expiresAt: 'x',
  },
  proofScore: {
    value: 0.87,
    confidence: 0.87,
    interval: [0.87, 1],
    sampleSize: 27,
    method: 'wilson',
  },
  identity: { tokenId: id, owner: `0x${'ab'.repeat(20)}`, registrationFile: { resolved: true } },
  evidence: [{ predicate: 'agent.liveness_verdict', count: 27, latestAt: 'x' }],
  components: { liveness: { successes: 27, trials: 27 }, safety: null, reputation: null },
  checks: { successes: 27, trials: 27 },
  image: 'https://example.test/icon.svg',
  registry: `0x${'cd'.repeat(20)}`,
  risks: [],
  insufficientEvidence: false,
  p95LatencyMs: 40,
  updatedAt: '2026-09-12T17:17:12.902Z',
})

function harness(rows: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ results: rows, total: rows.length }), { status: 200 }),
    ),
  )
}

it('carries what a buying decision is made of, and drops the rest', async () => {
  harness([row('315945')])
  const out = await runTool(ctx, 'search_agents', { query: 'grid' })
  const found = (out.body as { results: Record<string, unknown>[] }).results[0]
  expect(found).toEqual({
    agentId: '315945',
    name: 'Agent 315945',
    description: 'Does a thing.',
    liveness: 'LIVE',
    livenessDetail: 'Answered every check.',
    freshness: 'LIVE',
    checkedAt: '2026-09-12T17:17:12.902Z',
    proofScore: 0.87,
    trials: 27,
    owner: `0x${'ab'.repeat(20)}`,
  })
  vi.unstubAllGlobals()
})

it('keeps every claim the assistant is required to be able to make', async () => {
  // The prompt says to state what was measured before spending. That needs the
  // score, how many trials it came from, the grade and when it was checked.
  harness([row('315945')])
  const out = await runTool(ctx, 'search_agents', { query: 'grid' })
  const found = (out.body as { results: Record<string, unknown>[] }).results[0] ?? {}
  for (const key of ['proofScore', 'trials', 'liveness', 'freshness', 'checkedAt', 'owner'])
    expect(found[key], key).toBeDefined()
  vi.unstubAllGlobals()
})

it('is small enough that a turn can afford to look before it answers', async () => {
  harness(Array.from({ length: 8 }, (_v, i) => row(String(315940 + i))))
  const out = await runTool(ctx, 'search_agents', { query: 'grid' })
  const size = JSON.stringify(out.body).length
  // Eight full passports measured 19,349 characters against a 20,000 cap.
  expect(size).toBeLessThan(4_000)
  vi.unstubAllGlobals()
})

it('leaves a response that is not a result list alone', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'NOPE', message: 'no' } }), { status: 400 }),
    ),
  )
  const out = await runTool(ctx, 'search_agents', { query: 'grid' })
  expect(out.ok).toBe(false)
  expect((out.body as { error?: { code?: string } }).error?.code).toBe('NOPE')
  vi.unstubAllGlobals()
})
