/**
 * Fixture-backed mock of the AiKi API.
 *
 *   pnpm mock          → http://localhost:4700
 *
 * This exists so apps/web is never blocked on apps/api. Every endpoint in
 * docs/01-api-contract.md answers here with realistic data, including the
 * states that matter most — thin evidence, impostor endpoints, statistically
 * indistinguishable comparisons, policy denials and stale data.
 *
 * Query flags for exercising hard states:
 *   ?state=stale        → 503-style degraded payload with last-known data
 *   ?state=empty        → empty result set
 *   ?state=error        → error envelope
 *   ?slow=2000          → delay the response by N ms
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  AUTHORIZATION,
  COMPARE_INDISTINGUISHABLE,
  ECOSYSTEM_STATS,
  JOB_EVENTS,
  PASSPORT_STRONG,
  QUOTE,
  RECEIPT,
  SEARCH_RESPONSE,
} from './fixtures.js'
import type { ApiError, Job } from './types.js'

const app = new Hono()
app.use('*', cors())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const errorBody = (code: string, message: string, retryable: boolean): ApiError => ({
  error: { code, message, retryable, requestId: `req_${Math.floor(Date.now() / 1000)}` },
})

/** Honours ?slow= and ?state=error|stale for every route. */
app.use('*', async (c, next) => {
  const slow = Number(c.req.query('slow') ?? 0)
  if (slow > 0) await sleep(Math.min(slow, 10_000))

  const state = c.req.query('state')
  if (state === 'error') {
    return c.json(errorBody('UPSTREAM_UNAVAILABLE', 'Adapter is down.', true), 503)
  }
  await next()
})

app.get('/health', (c) => c.json({ ok: true, mock: true }))

// ── stats ────────────────────────────────────────────────────────────────────
app.get('/v1/stats', (c) => {
  if (c.req.query('state') === 'stale') {
    return c.json({ ...ECOSYSTEM_STATS, _freshness: { state: 'STALE', ageMs: 247_000 } }, 200, {
      'x-aiki-freshness': 'STALE',
    })
  }
  return c.json(ECOSYSTEM_STATS)
})

// ── search ───────────────────────────────────────────────────────────────────
app.post('/v1/search', async (c) => {
  if (c.req.query('state') === 'empty') {
    return c.json({
      results: [],
      total: 0,
      coverage: {
        ...SEARCH_RESPONSE.coverage,
        matchedBeforeFilters: 40,
        excludedUnverified: 40,
      },
    })
  }
  return c.json(SEARCH_RESPONSE)
})

// ── passport ─────────────────────────────────────────────────────────────────
app.get('/v1/agents/:id/passport', (c) => {
  const id = c.req.param('id')
  if (id !== PASSPORT_STRONG.agent.id && id !== 'agt_rangepilot') {
    return c.json(errorBody('NOT_FOUND', `No agent ${id}`, false), 404)
  }
  return c.json(PASSPORT_STRONG)
})

// ── compare ──────────────────────────────────────────────────────────────────
app.post('/v1/compare', (c) => c.json(COMPARE_INDISTINGUISHABLE))

// ── quote / authorization ────────────────────────────────────────────────────
app.post('/v1/quotes', (c) => c.json(QUOTE, 201))

app.post('/v1/authorizations', (c) => {
  if (!c.req.header('Idempotency-Key')) {
    return c.json(errorBody('IDEMPOTENCY_KEY_REQUIRED', 'Missing Idempotency-Key.', false), 400)
  }
  return c.json(AUTHORIZATION, 201)
})

app.post('/v1/authorizations/:id/revoke', (c) =>
  c.json({ ...AUTHORIZATION, status: 'revoked' as const }),
)

// ── jobs ─────────────────────────────────────────────────────────────────────
const JOB: Job = {
  jobId: 'job_01J8',
  status: 'RUNNING',
  agent: AUTHORIZATION.agent,
  authorizationId: AUTHORIZATION.authorizationId,
  quote: QUOTE,
  spent: AUTHORIZATION.spent,
  currentStep: 'Monitoring health factor',
  nextTrigger: { kind: 'condition', description: 'Health factor drops below 1.25' },
  createdAt: '2026-08-19T12:30:00Z',
  updatedAt: '2026-08-19T12:31:45Z',
}

app.post('/v1/jobs', (c) => {
  if (!c.req.header('Idempotency-Key')) {
    return c.json(errorBody('IDEMPOTENCY_KEY_REQUIRED', 'Missing Idempotency-Key.', false), 400)
  }
  return c.json(JOB, 201)
})

app.get('/v1/jobs/:id', (c) => c.json(JOB))

/**
 * SSE stream. Replays the fixture event sequence with a small delay so Mission
 * Control can be built against a genuinely live-feeling stream — including the
 * policy DENY and the approval request, which are the two events that matter.
 */
app.get('/v1/jobs/:id/events', () => {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      for (const event of JOB_EVENTS) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
        await sleep(900)
      }
      controller.enqueue(enc.encode('event: done\ndata: {}\n\n'))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})

// ── receipt ──────────────────────────────────────────────────────────────────
app.get('/v1/receipts/:id', (c) => c.json(RECEIPT))

// ── intent ───────────────────────────────────────────────────────────────────
app.post('/v1/intent', async (c) => {
  const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string })
  return c.json({
    intentId: 'int_01J8',
    parsed: {
      category: 'health_factor',
      protocols: ['Venus'],
      assets: ['USDT', 'BTC'],
      budget: { maxTotal: QUOTE.total },
      risk: { minConfidence: 0.8 },
      autonomy: 'bounded',
      requiredPermissions: ['read_position', 'repay_debt'],
      successCriteria: body.text ?? 'Keep health factor above 1.25',
    },
    editable: true,
    ambiguities: [
      {
        field: 'budget',
        question: 'How much may this agent spend in total?',
        options: ['100 U', '250 U', '500 U'],
      },
    ],
  })
})

app.notFound((c) => c.json(errorBody('NOT_FOUND', 'No such route.', false), 404))

const port = Number(process.env.PORT ?? 4700)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\n  AiKi mock API → http://localhost:${info.port}`)
  console.log('  fixtures include: thin evidence, IMPOSTOR_STATIC, indistinguishable')
  console.log('  compare, a policy DENY and an approval request.\n')
  console.log('  flags: ?state=stale|empty|error  ?slow=2000\n')
})

export { app }
