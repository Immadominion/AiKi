/**
 * Does the marketplace find and quote its own agents?
 *
 * Wires the evidence readers exactly as `main.ts` does, against whatever
 * DATABASE_URL points at, and asks the questions a judge would ask. Run it
 * against a copy of production and the answers are production's answers.
 *
 *   DATABASE_URL=postgresql://... pnpm search:check
 */

import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { createApiServer } from './server.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

const store = new PostgresEvidenceStore(databaseUrl)
const app = createApiServer({
  observations: () => store.list(),
  statsAggregate: () => store.statsAggregate(),
  observationsForLiveness: (states) => store.observationsForLiveness(states),
  observationsForAgents: (agentIds) => store.observationsForAgents(agentIds),
  searchAgents: (query) => store.searchAgents(query),
})

const QUERIES = [
  'venus',
  'protect my loan from liquidation',
  'yield',
  'grid trading',
  'pancakeswap',
  'guardian',
  'agent',
  'rebalance my liquidity position',
]

async function search(body: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: '/v1/search', payload: body })
  return response.json() as {
    results: { agentId: string; name: string | null; liveness: string }[]
    total: number
    coverage: Record<string, unknown>
  }
}

const scoped = await search({ limit: 250 })
console.log(`no query (SQL-scoped path): ${scoped.total} agents`)
const named = scoped.results.filter((r) => r.name)
console.log(`  of which carry a name: ${named.length}`)
for (const r of named.slice(0, 6)) console.log(`    ${r.agentId} ${r.name} [${r.liveness}]`)

console.log('\ntext queries:')
for (const query of QUERIES) {
  const answer = await search({ query })
  const found = answer.results.map((r) => r.agentId).join(', ') || 'nothing'
  console.log(
    `  ${JSON.stringify(query).padEnd(38)} -> ${String(answer.total).padStart(3)}  ${found}`,
  )
  console.log(`     coverage ${JSON.stringify(answer.coverage)}`)
}

/*
 * The passport is read per agent and unwindowed, so it is the control: whatever
 * it says is true of the store, and any disagreement with search is search's
 * fault rather than the data's.
 */
console.log('\ncontrol, per-agent passport (unwindowed):')
for (const agentId of ['315943', '315944', '315945', '315946']) {
  const response = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/passport` })
  const passport = response.json() as { name: string | null; liveness: string }
  console.log(`  ${agentId} ${String(passport.name)} [${passport.liveness}]`)
}

/*
 * Hiring is the other half of the brief. `/v1/quotes` projects the passport off
 * the same capped page rather than through the per-agent reader, so it is
 * subject to the same window: an agent that cannot be seen cannot be hired.
 */
console.log('\nhire path, POST /v1/quotes:')
for (const agentId of ['315943', '315944', '315945', '315946']) {
  const response = await app.inject({ method: 'POST', url: '/v1/quotes', payload: { agentId } })
  const body = response.json() as { error?: { code: string } }
  console.log(`  ${agentId} -> ${response.statusCode} ${body.error?.code ?? 'quoted'}`)
}

/*
 * Browsing is open, hiring is not. A catalogue that lists a known impostor is
 * only honest if you still cannot buy from it.
 */
console.log('\nbrowse vs hire:')
for (const agentId of ['315943', '310108']) {
  const listed = await app.inject({
    method: 'POST',
    url: '/v1/search',
    payload: { query: agentId },
  })
  const found = (listed.json() as { results: { agentId: string; liveness: string }[] }).results
  const quote = await app.inject({ method: 'POST', url: '/v1/quotes', payload: { agentId } })
  const body = quote.json() as { error?: { code: string } }
  console.log(
    `  ${agentId}  listed=${found.some((r) => r.agentId === agentId)}` +
      ` state=${found.find((r) => r.agentId === agentId)?.liveness ?? '-'}` +
      `  hire=${quote.statusCode} ${body.error?.code ?? 'QUOTED'}`,
  )
}

await app.close()
await store.close()
