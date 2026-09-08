import { PostgresEvidenceStore } from '../../evidence/postgres-store.js'
import { PancakeV3Client } from './client.js'
import { createPancakeRebalancerServer } from './server.js'

const rpcUrl = process.env.BSC_RPC_URL
if (!rpcUrl) throw new Error('BSC_RPC_URL is required.')
const evidenceStore = process.env.DATABASE_URL
  ? new PostgresEvidenceStore(process.env.DATABASE_URL)
  : undefined
const base = process.env.REFERENCE_AGENT_BASE_URL
const agentId = process.env.PANCAKE_REBALANCER_AGENT_ID
const app = createPancakeRebalancerServer({
  reader: new PancakeV3Client(rpcUrl),
  ...(base && agentId ? { registration: { publicBaseUrl: base, agentId } } : {}),
  ...(evidenceStore ? { evidenceStore } : {}),
})
try {
  await app.listen({ port: Number(process.env.PORT ?? '3002'), host: '0.0.0.0' })
} finally {
  await app.close()
  await evidenceStore?.close()
}
