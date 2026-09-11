import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { createCurrentRegistrationReader, probeCurrentCandidate } from './current-registration.js'
import { type ProbeCandidate, runProbeSweep } from './sweep.js'

const databaseUrl = process.env.DATABASE_URL
const rpcUrl = process.env.BSC_RPC_URL
if (!databaseUrl || !rpcUrl) throw new Error('DATABASE_URL and BSC_RPC_URL are required.')

const limit = Number(process.env.PROBE_LIMIT ?? '200')
const concurrency = Number(process.env.PROBE_CONCURRENCY ?? '6')
const budgetMs = Number(process.env.PROBE_BUDGET_MS ?? String(10 * 60_000))
const staleAfterHours = Number(process.env.PROBE_STALE_HOURS ?? '24')

const store = new PostgresEvidenceStore(databaseUrl)
const registryReader = createCurrentRegistrationReader(rpcUrl)
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
    (candidate) => probeCurrentCandidate(candidate, registryReader, store),
    { concurrency, budgetMs },
  )

  console.log(JSON.stringify({ due: candidates.length, ...result }, null, 2))
} finally {
  await store.close()
}
