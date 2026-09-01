/** One production process: marketplace API plus all first-party reference-agent routes. */
import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { viemAccountDeployer } from './accounts/deploy.js'
import { PostgresAccountStore } from './accounts/store.js'
import { PostgresNonceStore } from './auth/nonce-store.js'
import { describeCookieMismatch, SessionSigner } from './auth/session.js'
import { viemChainReader } from './authority/chain-reader.js'
import { AIKI_ENFORCERS_BSC_TESTNET } from './config/enforcers.js'
import { PostgresCreditStore } from './credits/store.js'
import { PostgresEvidenceStore } from './evidence/postgres-store.js'
import { createApiServer } from './http/server.js'
import { COVERAGE_START_STREAM } from './indexer/evidence-sink.js'
import { PostgresJobStore } from './jobs/postgres-store.js'
import { JobService } from './jobs/service.js'
import { PostgresReceiptStore } from './receipts/postgres-store.js'
import { ReceiptService } from './receipts/service.js'
import { PancakeGridClient } from './reference/grid/client.js'
import { createGridServer } from './reference/grid/server.js'
import { reciprocalProof } from './reference/manifest.js'
import { PancakeV3Client } from './reference/rebalancer/client.js'
import { createPancakeRebalancerServer } from './reference/rebalancer/server.js'
import { VenusClient } from './reference/venus/client.js'
import { createVenusReferenceServer } from './reference/venus/server.js'
import { VenusYieldClient } from './reference/yield/client.js'
import { createYieldServer } from './reference/yield/server.js'
import { PostgresWatchStore } from './runner/store.js'

const rpcUrl = process.env.BSC_RPC_URL
const databaseUrl = process.env.DATABASE_URL
if (!rpcUrl || !databaseUrl) throw new Error('BSC_RPC_URL and DATABASE_URL are required.')
const store = new PostgresEvidenceStore(databaseUrl)
const jobStore = new PostgresJobStore(databaseUrl)
const receiptStore = new PostgresReceiptStore(databaseUrl)
// A receipt outlives the process that signed it, so a deployment without a
// stable seed would orphan every receipt it ever issued on its next restart.
const receiptSeed = process.env.RECEIPT_SIGNING_KEY
if (!receiptSeed)
  throw new Error(
    'RECEIPT_SIGNING_KEY is required: without a stable key, every restart invalidates all prior receipts.',
  )
const sessionSecret = process.env.SESSION_SECRET
if (!sessionSecret)
  throw new Error('SESSION_SECRET is required: it is what makes a session cookie unforgeable.')
const authDomain = process.env.AUTH_DOMAIN
if (!authDomain)
  throw new Error(
    'AUTH_DOMAIN is required: a signed-in message must name this host, or a signature for another site would be accepted here.',
  )
const webOrigin = process.env.WEB_ORIGIN
if (!webOrigin)
  throw new Error('WEB_ORIGIN is required: it is the one browser origin allowed to hold a session.')
const cookieMismatch = describeCookieMismatch(authDomain, webOrigin)
if (cookieMismatch) throw new Error(cookieMismatch)
const nonceStore = new PostgresNonceStore(databaseUrl)
/**
 * The agent's session key address. Absent means this deployment cannot prepare
 * a delegation to sign, which is a real state and not an error: everything else
 * still works and the limits are counted by AiKi.
 */
const agentSessionKey = process.env.AGENT_SESSION_ADDRESS as `0x${string}` | undefined
/**
 * Signs redemptions and pays their gas. Its address must be AGENT_SESSION_ADDRESS,
 * because the manager accepts a redemption only from the delegate a mandate
 * names. Absent means actions are decided off chain and submitted nowhere.
 */
const agentKey = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined
/**
 * Pays gas to put a person's mandate account on chain, and nothing else. It is
 * not an owner and not an executor: the worst it can do if it leaks is waste gas
 * deploying accounts for strangers. Absent means this deployment cannot make
 * accounts, which every screen has to be able to say.
 */
const accountFunderKey = process.env.ACCOUNT_FUNDER_PRIVATE_KEY as `0x${string}` | undefined
const accountStore = new PostgresAccountStore(databaseUrl)
const watchStore = new PostgresWatchStore(databaseUrl)
const creditStore = new PostgresCreditStore(databaseUrl)

/*
 * Fast mode. Absent key means this deployment serves Manual mode only and says
 * so on the route, rather than failing in a way that reads like a bug.
 *
 * The assistant reaches this same API over loopback with the caller's own
 * session, so it can do exactly what that person could do by clicking. That is
 * the whole security model, and it depends on selfUrl pointing at this process
 * and nothing else.
 */
const assistantKey = process.env.ANTHROPIC_API_KEY
const treasury = process.env.CREDITS_TREASURY_ADDRESS as `0x${string}` | undefined
const creditsToken =
  (process.env.CREDITS_TOKEN_ADDRESS as `0x${string}` | undefined) ??
  '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c'
const enforcerRpcUrl =
  process.env.ENFORCER_RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
const base = process.env.REFERENCE_AGENT_BASE_URL
const venusId = process.env.VENUS_GUARDIAN_AGENT_ID
const rebalancerId = process.env.PANCAKE_REBALANCER_AGENT_ID
const gridId = process.env.PANCAKE_GRID_AGENT_ID
const yieldId = process.env.YIELD_OPTIMIZER_AGENT_ID
const app = createApiServer({
  observations: () => store.list(),
  coverageStart: async () =>
    (await store.getCheckpoint(COVERAGE_START_STREAM))?.lastIndexedBlock ?? null,
  statsAggregate: () => store.statsAggregate(),
  observationsForLiveness: (states) => store.observationsForLiveness(states),
  observationsForAgents: (agentIds) => store.observationsForAgents(agentIds),
  searchAgents: (query) => store.searchAgents(query),
  ...(treasury ? { settlementTreasury: treasury } : {}),
  enforcers: AIKI_ENFORCERS_BSC_TESTNET,
  ...(agentSessionKey ? { agentSessionKey } : {}),
  ...(agentKey ? { agentKey } : {}),
  enforcerRpcUrl,
  // Reads the chain the enforcers are on, which is not the one the rest of this
  // process talks to: the registry and the reference agents are on mainnet and
  // the mandate suite is on testnet. Sharing one client would check a signature
  // against an account that does not exist there.
  chain: viemChainReader(enforcerRpcUrl),
  ...(accountFunderKey
    ? {
        accounts: {
          store: accountStore,
          deployer: viemAccountDeployer({
            rpcUrl: enforcerRpcUrl,
            chainId: AIKI_ENFORCERS_BSC_TESTNET.chainId,
            manager: AIKI_ENFORCERS_BSC_TESTNET.manager as `0x${string}`,
            funderKey: accountFunderKey,
          }),
        },
      }
    : {}),
  jobs: new JobService(jobStore),
  watches: watchStore,
  assistant: {
    credits: creditStore,
    ...(assistantKey ? { apiKey: assistantKey } : {}),
    ...(process.env.ASSISTANT_MODEL ? { model: process.env.ASSISTANT_MODEL } : {}),
    selfUrl: `http://127.0.0.1:${Number(process.env.PORT ?? '3000')}`,
    ...(treasury
      ? {
          deposits: {
            rpcUrl: enforcerRpcUrl,
            chainId: 97,
            token: creditsToken,
            treasury,
          },
        }
      : {}),
  },
  receipts: new ReceiptService(receiptSeed, receiptStore),
  auth: {
    signer: new SessionSigner(sessionSecret),
    nonces: nonceStore,
    domain: authDomain,
    secureCookies: true,
    client: createPublicClient({ chain: bsc, transport: http(rpcUrl) }),
  },
})
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
  ...(base && gridId ? { registration: { publicBaseUrl: base, agentId: gridId } } : {}),
  evidenceStore: store,
})
const yieldAgent = createYieldServer({
  reader: new VenusYieldClient(rpcUrl),
  ...(base && yieldId ? { registration: { publicBaseUrl: base, agentId: yieldId } } : {}),
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
app.get('/v1/reference/pancake/grid/*', (request, reply) =>
  delegate(grid as unknown as Injectable, request, reply),
)
app.get('/v1/reference/yield', (request, reply) =>
  delegate(yieldAgent as unknown as Injectable, request, reply),
)
app.get('/v1/reference/yield/*', (request, reply) =>
  delegate(yieldAgent as unknown as Injectable, request, reply),
)
app.get('/.well-known/agent-registration.json', async (_request, reply) => {
  // D8 asks whoever controls this domain to acknowledge the on-chain ids. All four
  // agents share one host, so one file names all four.
  const ids = base ? [venusId, rebalancerId, gridId, yieldId].filter(Boolean) : []
  if (!ids.length)
    return reply.code(503).send({
      error: { code: 'REFERENCE_NOT_REGISTERED', message: 'No configured reference identities.' },
    })
  return reciprocalProof(ids as string[])
})
app.addHook('onClose', async () => {
  await Promise.all([venus.close(), rebalancer.close(), grid.close(), yieldAgent.close()])
  await Promise.all([
    store.close(),
    jobStore.close(),
    receiptStore.close(),
    nonceStore.close(),
    accountStore.close(),
  ])
})
const port = Number(process.env.PORT ?? '3000')
await app.listen({ host: '0.0.0.0', port })
// Say so. A process that boots silently is indistinguishable from one that hung,
// and the difference matters most exactly when a deploy is failing.
console.log(`aiki api listening on :${port}`)
