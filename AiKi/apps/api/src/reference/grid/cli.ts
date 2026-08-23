import { PostgresEvidenceStore } from '../../evidence/postgres-store.js'
import { PancakeGridClient } from './client.js'
import { createGridServer } from './server.js'

if (!process.env.BSC_RPC_URL) throw new Error('BSC_RPC_URL is required.')
const store = process.env.DATABASE_URL
  ? new PostgresEvidenceStore(process.env.DATABASE_URL)
  : undefined
const app = createGridServer({
  reader: new PancakeGridClient(process.env.BSC_RPC_URL),
  ...(process.env.PANCAKE_GRID_AGENT_ID ? { agentId: process.env.PANCAKE_GRID_AGENT_ID } : {}),
  ...(store ? { evidenceStore: store } : {}),
})
try {
  await app.listen({ port: Number(process.env.PORT ?? '3003'), host: '0.0.0.0' })
} finally {
  await app.close()
  await store?.close()
}
