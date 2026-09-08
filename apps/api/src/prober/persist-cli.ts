import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { persistVerification } from './evidence-sink.js'
import { probeAgent } from './probe.js'
import { resolveRegistration } from './registration.js'
import { CHAIN_ID, getAgent, REGISTRY } from './scan-client.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')
const agentId = process.argv.at(2)
if (!agentId) throw new Error('Usage: probe:persist -- <ERC-8004 token id>')

const detail = await getAgent(agentId)
const uri = detail.raw_metadata?.offchain_uri
if (!uri) throw new Error(`Agent ${agentId} has no onchain registration URI.`)
const registration = await resolveRegistration(uri)
const probe = await probeAgent({
  agentId,
  registry: `eip155:${CHAIN_ID}:${REGISTRY}`,
  services: registration.manifest?.services ?? [],
  agentUri: uri,
})
const store = new PostgresEvidenceStore(databaseUrl)
try {
  const result = await persistVerification(store, {
    chainId: CHAIN_ID,
    registry: REGISTRY,
    agentId,
    registration,
    probe,
    identityVerified: true,
  })
  console.log(
    JSON.stringify(
      {
        agentId,
        runId: result.runId,
        observationsInserted: result.observationsInserted,
        readiness: result.readiness,
      },
      null,
      2,
    ),
  )
} finally {
  await store.close()
}
