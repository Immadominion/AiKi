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
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import type { Observation } from '../evidence/types.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { sweepObservations } from '../prober/sweep-observations.js'
import { PostgresReceiptStore } from '../receipts/postgres-store.js'
import { ReceiptService } from '../receipts/service.js'
import { createApiServer } from './server.js'

function loadSweeps(root: string): Observation[] {
  const files = readdirSync(root)
    .filter((name) => /^probe-sweep-.*\.json$/.test(name))
    .sort()
    .map((name) => ({ name, raw: readFileSync(join(root, name), 'utf8') }))
  return sweepObservations(files)
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
