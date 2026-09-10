/** One production process: marketplace API plus all first-party reference-agent routes. */

import postgres from 'postgres'
import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { viemAccountDeployer } from './accounts/deploy.js'
import { PostgresAccountStore } from './accounts/store.js'
import { PostgresConversationStore } from './assistant/conversations.js'
import { PostgresNonceStore } from './auth/nonce-store.js'
import { describeCookieMismatch, SessionSigner } from './auth/session.js'
import { viemChainReader } from './authority/chain-reader.js'
import { createWatchMandateVerifier } from './authority/watch-readiness.js'
import { BSC_MAINNET } from './config/chains.js'
import { creditsNetwork } from './config/credits-network.js'
import { executionNetwork, verifyExecutionNetwork } from './config/execution-network.js'
import { accountFunderIdentity, executorIdentity } from './config/executor-identity.js'
import { checkCreditLedger, historicalCreditNetworks } from './credits/reconcile-backing.js'
import { PostgresCreditStore } from './credits/store.js'
import { PostgresEvidenceStore } from './evidence/postgres-store.js'
import { createApiServer } from './http/server.js'
import { COVERAGE_START_STREAM } from './indexer/evidence-sink.js'
import { PostgresJobStore } from './jobs/postgres-store.js'
import { JobService } from './jobs/service.js'
import { PostgresMarketplaceStore } from './marketplace/store.js'
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
import { createWatchActivationReader } from './runner/routes.js'
import { PostgresWatchStore } from './runner/store.js'
import { loadStrategyDeploymentConfig } from './strategies/deployment-config.js'
import { StrategySetupService } from './strategies/setup.js'
import { PostgresStrategySetupStore } from './strategies/setup-store.js'
import { PostgresStrategyStore } from './strategies/store.js'
import { PostgresSellerStore } from './tasks/sellers.js'
import { PostgresTaskStore } from './tasks/store.js'

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
 * Derive the executor we control and reject an explicit session-address mismatch.
 * An address without a private key remains signing-only; it cannot activate a
 * watch. The execution key redeems signed mandates and pays its own gas.
 */
const { agentSessionKey, agentKey } = executorIdentity(process.env)
/**
 * Pays gas to put a person's mandate account on chain, and nothing else. It is
 * not an owner and not an executor: the worst it can do if it leaks is waste gas
 * deploying accounts for strangers. Absent means this deployment cannot make
 * accounts, which every screen has to be able to say.
 */
const { funderKey: accountFunderKey } = accountFunderIdentity(process.env)
const accountStore = new PostgresAccountStore(databaseUrl)
const watchStore = new PostgresWatchStore(databaseUrl)
const creditStore = new PostgresCreditStore(databaseUrl)
const conversationStore = new PostgresConversationStore(databaseUrl)
/*
 * A separate, single connection for reading the books.
 *
 * The credit store's pool is for moving money and a reconciliation scan should
 * never be the reason a payment waits for a connection. One is enough: this
 * runs when somebody asks, not on a loop.
 */
const ledgerSql = postgres(databaseUrl, { max: 1 })
const strategySql = postgres(databaseUrl, { max: 5 })
const taskStore = new PostgresTaskStore(databaseUrl)
const sellerStore = new PostgresSellerStore(databaseUrl)
const marketplaceStore = new PostgresMarketplaceStore(databaseUrl)

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
const deposits = creditsNetwork(process.env)
const historicalDeposits = historicalCreditNetworks(process.env)
const treasury = deposits?.treasury
const execution = await executionNetwork(process.env)
await verifyExecutionNetwork(execution)
const deployment = execution.deployment
const enforcerRpcUrl = execution.rpcUrl
/*
 * Where a hired agent sends work back to: this API, as the outside world sees
 * it. Railway names the deployment's own domain, so a deployment that forgot to
 * set anything still dispatches rather than quietly not calling anybody.
 */
const publicApiUrl =
  process.env.PUBLIC_API_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined)
const base = process.env.REFERENCE_AGENT_BASE_URL
const venusId = process.env.VENUS_GUARDIAN_AGENT_ID
const rebalancerId = process.env.PANCAKE_REBALANCER_AGENT_ID
const gridId = process.env.PANCAKE_GRID_AGENT_ID
const yieldId = process.env.YIELD_OPTIMIZER_AGENT_ID
const strategyAgentIds = { lp: rebalancerId, grid: gridId, yield: yieldId }
const strategyAgents = base
  ? Object.fromEntries(
      Object.entries(strategyAgentIds)
        .filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && /^[1-9][0-9]{0,77}$/.test(entry[1]),
        )
        .map(([kind, agentId]) => [
          kind,
          { agentId, registry: BSC_MAINNET.contracts.erc8004Identity, chainId: 56 as const },
        ]),
    )
  : {}
const strategies = new StrategySetupService({
  store: new PostgresStrategySetupStore(strategySql),
  strategies: new PostgresStrategyStore(strategySql),
  deployments:
    deployment.chainId === 56
      ? loadStrategyDeploymentConfig(process.env.STRATEGY_DEPLOYMENT_CONFIG)
      : null,
  ...(agentSessionKey ? { executor: agentSessionKey } : {}),
  reader: createPublicClient({
    chain: bsc,
    transport: http(enforcerRpcUrl, { timeout: 8000, retryCount: 1 }),
  }),
  agents: strategyAgents,
})
const app = createApiServer({
  strategies,
  observations: () => store.list(),
  coverageStart: async () =>
    (await store.getCheckpoint(COVERAGE_START_STREAM))?.lastIndexedBlock ?? null,
  statsAggregate: () => store.statsAggregate(),
  observationsForLiveness: (states) => store.observationsForLiveness(states),
  observationsForAgents: (agentIds) => store.observationsForAgents(agentIds),
  searchAgents: (query) => store.searchAgents(query),
  ...(treasury ? { settlementTreasury: treasury } : {}),
  tasks: taskStore,
  sellers: sellerStore,
  marketplace: marketplaceStore,
  // Where a hired agent sends work back to, and the key that proves the callback
  // belongs to a task AiKi actually dispatched.
  ...(publicApiUrl ? { publicUrl: publicApiUrl } : {}),
  deliverySecret: receiptSeed,
  // Names and verdicts only. The route is public and the amounts are not.
  ledgerHealth: async () =>
    (await checkCreditLedger(ledgerSql, deposits, historicalDeposits)).map(({ check, ok }) => ({
      check,
      ok,
    })),
  appendObservation: (observation) => store.append(observation),
  enforcers: deployment,
  ...(agentSessionKey ? { agentSessionKey } : {}),
  ...(agentKey ? { agentKey } : {}),
  enforcerRpcUrl,
  // Account ownership, signature verification and execution use one selected
  // deployment. Never read a mainnet mandate against the testnet account.
  chain: viemChainReader(enforcerRpcUrl),
  ...(accountFunderKey
    ? {
        accounts: {
          store: accountStore,
          deployer: viemAccountDeployer({
            store: accountStore,
            rpcUrl: enforcerRpcUrl,
            chainId: deployment.chainId,
            manager: deployment.manager as `0x${string}`,
            funderKey: accountFunderKey,
          }),
        },
      }
    : {}),
  jobs: new JobService(jobStore),
  watches: watchStore,
  ...(agentKey
    ? {
        watchActivation: createWatchActivationReader(
          enforcerRpcUrl,
          undefined,
          deployment.chainId,
          agentSessionKey,
          createWatchMandateVerifier({ rpcUrl: enforcerRpcUrl, deployment }),
        ),
      }
    : {}),
  assistant: {
    credits: creditStore,
    executionChainId: deployment.chainId as 56 | 97,
    conversations: conversationStore,
    ...(assistantKey ? { apiKey: assistantKey } : {}),
    ...(process.env.ASSISTANT_MODEL ? { model: process.env.ASSISTANT_MODEL } : {}),
    selfUrl: `http://127.0.0.1:${Number(process.env.PORT ?? '3000')}`,
    ...(deposits ? { deposits } : {}),
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
  request: { method: string; url: string; headers: Record<string, unknown>; body?: unknown },
  reply: {
    code(code: number): { send(value: string): unknown }
    header(key: string, value: string): unknown
  },
) {
  const response = await child.inject({
    method: request.method,
    url: request.url,
    headers: request.headers as Record<string, string>,
    /*
     * The body travels too. It did not, and nothing noticed while only GET was
     * delegated: a reference agent could be read and not asked for anything.
     * Hiring one arrives as a POST carrying the brief, and a delegation that
     * drops it would hand the agent an empty request and record the answer as
     * evidence about the agent.
     */
    ...(request.body === undefined ? {} : { payload: request.body as never }),
  })
  for (const [key, value] of Object.entries(response.headers))
    if (value && !['content-length', 'connection'].includes(key.toLowerCase()))
      reply.header(key, value)
  return reply.code(response.statusCode).send(response.body)
}
app.get('/v1/reference/venus/*', (request, reply) =>
  delegate(venus as unknown as Injectable, request, reply),
)
/*
 * Hiring a reference agent, which arrives as a POST carrying the brief.
 *
 * Delegated for the same reason reads are: these agents are separate servers
 * with their own identities, and the outer API is the address the world knows.
 * Without this the endpoint an agent's own ERC-8004 registration declares
 * answers 404 to the marketplace that registered it, which is what it did.
 */
app.post('/v1/reference/venus/*', (request, reply) =>
  delegate(venus as unknown as Injectable, request, reply),
)
app.get('/v1/reference/pancake/rebalancer/*', (request, reply) =>
  delegate(rebalancer as unknown as Injectable, request, reply),
)
app.post('/v1/reference/pancake/rebalancer/*', (request, reply) =>
  delegate(rebalancer as unknown as Injectable, request, reply),
)
app.get('/v1/reference/pancake/grid', (request, reply) =>
  delegate(grid as unknown as Injectable, request, reply),
)
app.get('/v1/reference/pancake/grid/*', (request, reply) =>
  delegate(grid as unknown as Injectable, request, reply),
)
app.post('/v1/reference/pancake/grid/*', (request, reply) =>
  delegate(grid as unknown as Injectable, request, reply),
)
app.get('/v1/reference/yield', (request, reply) =>
  delegate(yieldAgent as unknown as Injectable, request, reply),
)
app.get('/v1/reference/yield/*', (request, reply) =>
  delegate(yieldAgent as unknown as Injectable, request, reply),
)
app.post('/v1/reference/yield/*', (request, reply) =>
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
    marketplaceStore.close(),
    conversationStore.close(),
    creditStore.close(),
    watchStore.close(),
    taskStore.close(),
    sellerStore.close(),
    ledgerSql.end(),
    strategySql.end(),
  ])
})
const port = Number(process.env.PORT ?? '3000')
await app.listen({ host: '0.0.0.0', port })
// Say so. A process that boots silently is indistinguishable from one that hung,
// and the difference matters most exactly when a deploy is failing.
console.log(`aiki api listening on :${port}`)
