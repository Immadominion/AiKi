import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { persistVerification } from './evidence-sink.js'
import { probeAgent } from './probe.js'
import { resolveRegistration } from './registration.js'
import { type ProbeCandidate, runProbeSweep } from './sweep.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

const limit = Number(process.env.PROBE_LIMIT ?? '200')
const concurrency = Number(process.env.PROBE_CONCURRENCY ?? '6')
const budgetMs = Number(process.env.PROBE_BUDGET_MS ?? String(10 * 60_000))
const staleAfterHours = Number(process.env.PROBE_STALE_HOURS ?? '24')

const store = new PostgresEvidenceStore(databaseUrl)
try {
  const rows = await store.dueForProbe(limit, staleAfterHours)
  const candidates: ProbeCandidate[] = rows.map((row) => ({
    agentId: row.agent_id,
    chainId: row.chain_id,
    registry: row.registry_address,
    agentUri: row.agent_uri,
    lastProbedAt:
      row.last_probed_at instanceof Date
        ? row.last_probed_at.toISOString()
        : (row.last_probed_at ?? null),
  }))

  const result = await runProbeSweep(
    candidates,
    async (candidate) => {
      const registration = await resolveRegistration(candidate.agentUri)
      const probe = await probeAgent({
        agentId: candidate.agentId,
        registry: `eip155:${candidate.chainId}:${candidate.registry}`,
        services: registration.manifest?.services ?? [],
        agentUri: candidate.agentUri,
      })
      const persisted = await persistVerification(store, {
        chainId: candidate.chainId,
        registry: candidate.registry,
        agentId: candidate.agentId,
        registration,
        probe,
        identityVerified: true,
      })
      return persisted.observationsInserted
    },
    { concurrency, budgetMs },
  )

  console.log(JSON.stringify({ due: candidates.length, ...result }, null, 2))
} finally {
  await store.close()
}
