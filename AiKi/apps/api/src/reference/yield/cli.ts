import { PostgresEvidenceStore } from '../../evidence/postgres-store.js'
import { VenusYieldClient } from './client.js'
import { createYieldServer } from './server.js'
if (!process.env.BSC_RPC_URL) throw new Error('BSC_RPC_URL is required.')
const store = process.env.DATABASE_URL ? new PostgresEvidenceStore(process.env.DATABASE_URL) : undefined
const app = createYieldServer({ reader: new VenusYieldClient(process.env.BSC_RPC_URL), ...(process.env.YIELD_OPTIMIZER_AGENT_ID ? { agentId: process.env.YIELD_OPTIMIZER_AGENT_ID } : {}), ...(store ? { evidenceStore: store } : {}) })
try { await app.listen({ port: Number(process.env.PORT ?? '3004'), host: '0.0.0.0' }) } finally { await app.close(); await store?.close() }
