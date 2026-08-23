/** One production process: marketplace API plus all first-party reference-agent routes. */
import { PostgresEvidenceStore } from './evidence/postgres-store.js'
import { createApiServer } from './http/server.js'
import { PancakeGridClient } from './reference/grid/client.js'
import { createGridServer } from './reference/grid/server.js'
import { PancakeV3Client } from './reference/rebalancer/client.js'
import { createPancakeRebalancerServer } from './reference/rebalancer/server.js'
import { VenusClient } from './reference/venus/client.js'
import { createVenusReferenceServer } from './reference/venus/server.js'
import { VenusYieldClient } from './reference/yield/client.js'
import { createYieldServer } from './reference/yield/server.js'

const rpcUrl = process.env.BSC_RPC_URL
const databaseUrl = process.env.DATABASE_URL
if (!rpcUrl || !databaseUrl) throw new Error('BSC_RPC_URL and DATABASE_URL are required.')
const store = new PostgresEvidenceStore(databaseUrl)
const base = process.env.REFERENCE_AGENT_BASE_URL
const venusId = process.env.VENUS_GUARDIAN_AGENT_ID
const rebalancerId = process.env.PANCAKE_REBALANCER_AGENT_ID
const gridId = process.env.PANCAKE_GRID_AGENT_ID
const yieldId = process.env.YIELD_OPTIMIZER_AGENT_ID
const app = createApiServer({ observations: () => store.list() })
const venus = createVenusReferenceServer({
  reader: new VenusClient(rpcUrl),
  ...(base && venusId ? { registration: { publicBaseUrl: base, agentId: venusId } } : {}),
  evidenceStore: store,
})
const rebalancer = createPancakeRebalancerServer({
  reader: new PancakeV3Client(rpcUrl),
  ...(base && rebalancerId ? { registration: { publicBaseUrl: base, agentId: rebalancerId } } : {}),
  evidenceStore: store,
})
const grid = createGridServer({
  reader: new PancakeGridClient(rpcUrl),
  ...(gridId ? { agentId: gridId } : {}),
  evidenceStore: store,
})
const yieldAgent = createYieldServer({
  reader: new VenusYieldClient(rpcUrl),
  ...(yieldId ? { agentId: yieldId } : {}),
  evidenceStore: store,
})
type Injectable = {
  inject(options: {
    method: string
    url: string
    headers: Record<string, string>
  }): Promise<{ statusCode: number; headers: Record<string, string | undefined>; body: string }>
}
async function delegate(
  child: Injectable,
  request: { method: string; url: string; headers: Record<string, unknown> },
  reply: {
    code(code: number): { send(value: string): unknown }
    header(key: string, value: string): unknown
  },
) {
  const response = await child.inject({
    method: request.method,
    url: request.url,
    headers: request.headers as Record<string, string>,
  })
  for (const [key, value] of Object.entries(response.headers))
    if (value && !['content-length', 'connection'].includes(key.toLowerCase()))
      reply.header(key, value)
  return reply.code(response.statusCode).send(response.body)
}
app.get('/v1/reference/venus/*', (request, reply) =>
  delegate(venus as unknown as Injectable, request, reply),
)
app.get('/v1/reference/pancake/rebalancer/*', (request, reply) =>
  delegate(rebalancer as unknown as Injectable, request, reply),
)
app.get('/v1/reference/pancake/grid', (request, reply) =>
  delegate(grid as unknown as Injectable, request, reply),
)
app.get('/v1/reference/yield', (request, reply) =>
  delegate(yieldAgent as unknown as Injectable, request, reply),
)
app.get('/.well-known/agent-registration.json', async (_request, reply) => {
  const registrations = [venusId, rebalancerId, gridId, yieldId]
    .filter((id): id is string => Boolean(id))
    .map((agentId) => ({
      agentId,
      agentRegistry: 'eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    }))
  if (!registrations.length)
    return reply.code(503).send({
      error: { code: 'REFERENCE_NOT_REGISTERED', message: 'No configured reference identities.' },
    })
  return { registrations }
})
app.addHook('onClose', async () => {
  await Promise.all([venus.close(), rebalancer.close(), grid.close(), yieldAgent.close()])
  await store.close()
})
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '3000') })
