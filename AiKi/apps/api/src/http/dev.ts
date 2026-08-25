/**
 * Local development API: the real server fed from committed probe sweeps.
 *
 * No Postgres, no RPC. Every probe-sweep-*.json in the package root becomes
 * observations through the same shapes the prober's evidence sink writes, so
 * the projections the frontend sees here are the ones production will serve —
 * over genuinely measured agents, not fixtures.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Observation } from '../evidence/types.js'
import { createApiServer } from './server.js'

interface SweepResult {
  agentId: string
  probedAt: string
  registrationWasZeroCost?: boolean
  verdict: { state: string; rule: string; detail: string; evidence?: Record<string, unknown> }
  samples?: Record<string, unknown>[]
  reciprocal?: { verified: boolean; detail: string }
}

interface SweepFile {
  sweptAt?: string
  chainId?: number
  registry?: string
  results?: SweepResult[]
}

function loadSweeps(root: string): Observation[] {
  const observations: Observation[] = []
  const files = readdirSync(root)
    .filter((name) => /^probe-sweep-.*\.json$/.test(name))
    .sort()
  for (const file of files) {
    let sweep: SweepFile
    try {
      sweep = JSON.parse(readFileSync(join(root, file), 'utf8')) as SweepFile
    } catch {
      continue
    }
    if (!Array.isArray(sweep.results)) continue
    for (const result of sweep.results) {
      if (!result?.agentId || typeof result.verdict?.state !== 'string') continue
      const subject = {
        type: 'agent' as const,
        chainId: sweep.chainId ?? 56,
        registry: sweep.registry ?? '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
        agentId: result.agentId,
      }
      const base = {
        subject,
        validAt: result.probedAt,
        observedAt: result.probedAt,
        recordedAt: result.probedAt,
        source: 'aiki:prober',
        evidenceClass: 'B' as const,
      }
      // The same probe run never lands twice even when sweeps overlap.
      const runKey = `${result.agentId}:${result.probedAt}`
      observations.push({
        ...base,
        id: `dev:${runKey}:verdict`,
        predicate: 'agent.liveness_verdict',
        method: `capability-probe/${result.verdict.rule}`,
        value: {
          state: result.verdict.state,
          detail: result.verdict.detail,
          evidence: result.verdict.evidence,
          registrationWasZeroCost: result.registrationWasZeroCost ?? false,
        },
        dedupeKey: `prober:${runKey}:verdict`,
      })
      if (result.reciprocal)
        observations.push({
          ...base,
          id: `dev:${runKey}:reciprocal`,
          predicate: 'erc8004.reciprocal_proof',
          method: 'reciprocal-proof/D8',
          value: result.reciprocal as unknown as Record<string, unknown>,
          dedupeKey: `prober:${runKey}:reciprocal`,
        })
      for (const [index, sample] of (result.samples ?? []).entries())
        observations.push({
          ...base,
          id: `dev:${runKey}:sample:${index}`,
          predicate: 'agent.capability_probe',
          method: 'capability-probe/v2',
          value: sample,
          dedupeKey: `prober:${runKey}:sample:${index}`,
        })
    }
  }
  const unique = new Map(observations.map((o) => [o.dedupeKey, o]))
  return [...unique.values()]
}

const observations = loadSweeps(process.cwd())
const agents = new Set(observations.map((o) => o.subject.agentId)).size
const app = createApiServer({ observations: () => observations })

// The web app runs on another localhost port; production CORS policy is the
// deployment's decision, not this harness's.
app.addHook('onRequest', async (request, reply) => {
  reply.header('access-control-allow-origin', '*')
  reply.header('access-control-allow-headers', 'content-type, idempotency-key')
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
  if (request.method === 'OPTIONS') return reply.code(204).send()
})

const port = Number(process.env.PORT ?? '4700')
await app.listen({ host: '127.0.0.1', port })
console.log(`aiki dev api: ${observations.length} observations over ${agents} agents on :${port}`)
