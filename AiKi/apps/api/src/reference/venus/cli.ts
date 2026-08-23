import { PostgresEvidenceStore } from '../../evidence/postgres-store.js'
import { VenusClient } from './client.js'
import { createVenusReferenceServer } from './server.js'

const rpcUrl = process.env.BSC_RPC_URL
if (!rpcUrl) throw new Error('BSC_RPC_URL is required.')
const publicBaseUrl = process.env.REFERENCE_AGENT_BASE_URL
const agentId = process.env.VENUS_GUARDIAN_AGENT_ID
const port = Number(process.env.PORT ?? '3001')
const evidenceStore = process.env.DATABASE_URL
  ? new PostgresEvidenceStore(process.env.DATABASE_URL)
  : undefined
const app = createVenusReferenceServer({
  reader: new VenusClient(rpcUrl),
  ...(publicBaseUrl && agentId ? { registration: { publicBaseUrl, agentId } } : {}),
  ...(evidenceStore ? { evidenceStore } : {}),
})
try {
  await app.listen({ port, host: '0.0.0.0' })
} finally {
  await app.close()
  await evidenceStore?.close()
}
