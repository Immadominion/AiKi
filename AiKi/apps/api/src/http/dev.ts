/**
 * Local development API: the real server fed from committed probe sweeps.
 *
 * No Postgres, no RPC. Every probe-sweep-*.json in the package root becomes
 * observations through the same shapes the prober's evidence sink writes, so
 * the projections the frontend sees here are the ones production will serve —
 * over genuinely measured agents, not fixtures.
 */

import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'
import { viemAccountDeployer } from '../accounts/deploy.js'
import { PostgresAccountStore } from '../accounts/store.js'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { viemChainReader } from '../authority/chain-reader.js'
import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'
import { materializeObservation } from '../evidence/store.js'
import type { Observation } from '../evidence/types.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { sweepObservations } from '../prober/sweep-observations.js'
import { PostgresReceiptStore } from '../receipts/postgres-store.js'
import { ReceiptService } from '../receipts/service.js'
import { PostgresWatchStore } from '../runner/store.js'
import { createApiServer } from './server.js'

/** Absent means this deployment cannot prepare a delegation to sign. */
const agentSessionKey = process.env.AGENT_SESSION_ADDRESS as `0x${string}` | undefined
const accountFunderKey = process.env.ACCOUNT_FUNDER_PRIVATE_KEY as `0x${string}` | undefined
const agentKey = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined
const enforcerRpc =
  process.env.ENFORCER_RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'

function loadSweeps(root: string): Observation[] {
  const files = readdirSync(root)
    .filter((name) => /^probe-sweep-.*\.json$/.test(name))
    .sort()
    .map((name) => ({ name, raw: readFileSync(join(root, name), 'utf8') }))
  // The store would do this; the dev server holds them in memory instead.
  return sweepObservations(files).map((o) => materializeObservation(o))
}

const observations = loadSweeps(process.cwd())
const agents = new Set(observations.map((o) => o.subject.agentId)).size
// Sign-in works here exactly as it does in production, against the same SIWE
// path. The secret is per-process, so restarting the dev server signs you out.
// Given a database, the dev server persists exactly like production does, so a
// mandate made here is a row you can go and look at. Without one it stays in
// memory and dies with the process.
const databaseUrl = process.env.DATABASE_URL
const persistence = databaseUrl
  ? {
      jobs: new JobService(new PostgresJobStore(databaseUrl)),
      // Watches too, or the one part of the product that works without a person
      // present is missing from the server a developer actually runs — which is
      // how it goes unnoticed that a screen calls a route nobody registered.
      watches: new PostgresWatchStore(databaseUrl),
      // The same deployed suite production reads, so what a limit is worth here
      // is what it is worth there. A dev API that reported everything as counted
      // by AiKi would make the builder's badges a local fiction.
      enforcers: AIKI_ENFORCERS_BSC_TESTNET,
      ...(agentSessionKey ? { agentSessionKey } : {}),
      ...(agentKey ? { agentKey } : {}),
      enforcerRpcUrl: enforcerRpc,
      // Accounts too, so the browser walk is the same walk production does. A
      // dev API that could not deploy one would make the hire flow fall back to
      // "AiKi counts your limits" and look like a bug in the web.
      ...(accountFunderKey
        ? {
            accounts: {
              store: new PostgresAccountStore(databaseUrl),
              deployer: viemAccountDeployer({
                rpcUrl: enforcerRpc,
                chainId: AIKI_ENFORCERS_BSC_TESTNET.chainId,
                manager: AIKI_ENFORCERS_BSC_TESTNET.manager as `0x${string}`,
                funderKey: accountFunderKey,
              }),
            },
          }
        : {}),
      chain: viemChainReader(enforcerRpc),
      receipts: new ReceiptService(
        process.env.RECEIPT_SIGNING_KEY ?? 'ab'.repeat(32),
        new PostgresReceiptStore(databaseUrl),
      ),
    }
  : {}

const app = createApiServer({
  observations: () => observations,
  ...persistence,
  auth: {
    signer: new SessionSigner(process.env.SESSION_SECRET ?? randomBytes(24).toString('hex')),
    nonces: new InMemoryNonceStore(),
    domain: process.env.AUTH_DOMAIN ?? 'localhost:4747',
    secureCookies: false,
    client: createPublicClient({
      chain: bsc,
      transport: http(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org'),
    }),
  },
})

// The web app runs on another localhost port; production CORS policy is the
// deployment's decision, not this harness's.
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4747'
app.addHook('onRequest', async (request, reply) => {
  // A wildcard origin cannot carry credentials, and the session is a cookie, so
  // the dev server names the one origin it trusts.
  reply.header('access-control-allow-origin', WEB_ORIGIN)
  reply.header('access-control-allow-credentials', 'true')
  reply.header('vary', 'origin')
  reply.header('access-control-allow-headers', 'content-type, idempotency-key')
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
  if (request.method === 'OPTIONS') return reply.code(204).send()
})

const port = Number(process.env.PORT ?? '4700')
await app.listen({ host: '127.0.0.1', port })
console.log(
  `aiki dev api: ${observations.length} observations over ${agents} agents on :${port} · mandates ${
    databaseUrl ? 'persisted in Postgres' : 'in memory only'
  }`,
)
