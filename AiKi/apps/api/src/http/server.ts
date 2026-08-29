import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { requireOwner, requireSession } from '../auth/guard.js'
import { requireIngestToken } from '../auth/ingest.js'
import type { AuthConfig } from '../auth/routes.js'
import { registerAuthRoutes } from '../auth/routes.js'
import { readCookie, SESSION_COOKIE } from '../auth/session.js'
import type { Constraint } from '../authority/policy.js'
import { type BenchmarkRun, BenchmarkService, benchmarkEvidence } from '../benchmarks/service.js'
import type { Observation } from '../evidence/types.js'
import { parseIntent } from '../intent/parser.js'
import { JobService } from '../jobs/service.js'
import { comparePassports, projectPassport } from '../projections/passport.js'
import { assembleStats, projectStats, type StatsAggregate } from '../projections/stats.js'
import { ReceiptService } from '../receipts/service.js'
import { buildQuote } from '../settlement/pricing.js'
import { publishedPrice } from '../settlement/published-price.js'
import { asClientError, asSchemaError } from './errors.js'

/** The most agents one comparison may name. See the check in /v1/compare. */
const COMPARE_MAX = 10

/** One page size rule for both search paths: 1 to 100, defaulting to 20. */
const clampLimit = (raw: number | undefined): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 100) : 20

export function createApiServer(input: {
  observations: () => Observation[] | Promise<Observation[]>
  /**
   * Lowest block the indexer has ever scanned from. Omitted by deployments with no
   * indexer, where coverage is genuinely unknown rather than zero.
   */
  coverageStart?: () => number | null | Promise<number | null>
  /**
   * Counted over every row. Deployments that can do this MUST, because folding
   * the dashboard out of `observations()` reads a capped page and the totals
   * then shrink as the store grows.
   */
  statsAggregate?: () => StatsAggregate | Promise<StatsAggregate>
  /**
   * Every observation for the agents whose latest verdict is one of `states`,
   * selected in SQL. Deployments that can do this MUST, for the same reason
   * `statsAggregate` exists: projecting a search over the capped `observations()`
   * page silently drops agents as the store grows, and the ones it drops are the
   * ones probed longest ago.
   */
  observationsForLiveness?: (states: string[]) => Observation[] | Promise<Observation[]>
  jobs?: JobService
  receipts?: ReceiptService
  benchmarks?: BenchmarkService
  /** Omitted only in tests of the public surface; every mandate route needs it. */
  auth?: AuthConfig
}) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const jobs = input.jobs ?? new JobService()
  const receipts = input.receipts ?? new ReceiptService(process.env.RECEIPT_SIGNING_KEY)
  const benchmarks = input.benchmarks ?? new BenchmarkService()
  app.addHook('onRequest', async (request, reply) => {
    const id = request.headers['x-request-id']?.toString() ?? randomUUID()
    request.headers['x-request-id'] = id
    reply.header('x-request-id', id)
    if (input.auth)
      request.session =
        input.auth.signer.verify(readCookie(request.headers.cookie, SESSION_COOKIE)) ?? undefined
  })
  if (input.auth) registerAuthRoutes(app, input.auth)
  /**
   * Only messages written for a caller reach a caller.
   *
   * Fastify's own schema errors are safe and useful, and anything raised as a
   * ClientError was phrased deliberately. Everything else is ours: it gets a 500,
   * a generic sentence and the request id, and the real text goes to the log.
   */
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.headers['x-request-id']
    const client = asClientError(error)
    if (client)
      return reply.code(client.statusCode).send({
        error: { code: client.code, message: client.message, retryable: false, requestId },
      })
    const schema = asSchemaError(error)
    if (schema)
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: schema, retryable: false, requestId },
      })
    request.log.error({ err: error, requestId }, 'unhandled request failure')
    return reply.code(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Something failed on our side. Quote the request id if you report it.',
        retryable: true,
        requestId,
      },
    })
  })

  /**
   * A job belongs to whoever owns its authorization. Deriving it rather than
   * copying it onto the job means the two can never disagree.
   */
  async function ownedJob(
    request: Parameters<typeof requireSession>[0],
    reply: Parameters<typeof requireSession>[1],
    address: string,
    jobId: string,
  ) {
    const job = await jobs.getJob(jobId)
    const authorization = await jobs.getAuthorization(job.authorizationId)
    if (authorization.owner?.toLowerCase() !== address.toLowerCase()) {
      reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'No such job.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
      return null
    }
    return job
  }
  /**
   * Liveness and readiness in one answer.
   *
   * Readiness means the evidence store actually responds, not that the process
   * is up: an API that returns 200 while its database is unreachable will be
   * kept in a load balancer's rotation while serving nothing.
   */
  app.get('/healthz', async (request, reply) => {
    try {
      await input.observations()
      return { status: 'ok' }
    } catch (error) {
      // A health endpoint is unauthenticated by design, so it says that it is
      // unhealthy and not why. The reason belongs in the log.
      request.log.error({ err: error }, 'healthcheck: evidence store unreachable')
      return reply.code(503).send({ status: 'degraded', detail: 'Evidence store unreachable.' })
    }
  })
  app.get('/v1/stats', async () => {
    const coverageStart = input.coverageStart ? await input.coverageStart() : null
    const opts = typeof coverageStart === 'number' ? { coverageStart } : {}
    return input.statsAggregate
      ? assembleStats(await input.statsAggregate(), opts)
      : projectStats(await input.observations(), opts)
  })
  app.get<{ Params: { agentId: string } }>('/v1/agents/:agentId/passport', async (request) =>
    projectPassport(request.params.agentId, await input.observations()),
  )
  app.post<{ Body: { agentIds: string[] } }>('/v1/compare', async (request, reply) => {
    if (!Array.isArray(request.body.agentIds) || request.body.agentIds.length < 2)
      return reply.code(400).send({
        error: {
          code: 'INVALID_COMPARE',
          message: 'At least two agentIds are required.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    /*
     * Bounded, because each id projects a passport over the whole observation
     * set and this route is unauthenticated. Measured at roughly 5ms per id, and
     * Fastify's default 1MB body holds about 116,000 of them, which is on the
     * order of ten minutes of blocked event loop from a single POST. Comparison
     * is pairwise and nobody reads a hundred agents side by side anyway.
     */
    if (request.body.agentIds.length > COMPARE_MAX)
      return reply.code(400).send({
        error: {
          code: 'TOO_MANY_AGENTS',
          message: `Compare takes at most ${COMPARE_MAX} agents at a time.`,
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    const observations = await input.observations()
    const passports = request.body.agentIds.map((id) => projectPassport(id, observations))
    return { agents: passports, ...comparePassports(passports) }
  })
  app.post<{ Body: { text: string } }>('/v1/intent', async (request) =>
    parseIntent(request.body.text),
  )
  app.post<{
    Body: { query?: string; filters?: { category?: string; liveness?: string[] }; limit?: number }
  }>('/v1/search', async (request) => {
    const query = request.body.query?.toLowerCase()
    // The contract's documented default: unverified agents are hidden but
    // counted. Passing filters.liveness explicitly overrides it.
    const wanted = request.body.filters?.liveness ?? ['LIVE', 'DEGRADED']

    /*
     * With no text query, the wanted states can be selected in SQL, so the
     * answer covers every agent in them instead of whichever ones sit in the
     * newest page of observations. Measured on production before this existed:
     * /v1/stats counted 13 LIVE agents and this route could see 4, and the 4
     * were simply the most recently probed, which were our own.
     *
     * A text query still runs over the capped page, because narrowing to the
     * wanted states first would make "how many did the filter exclude" a count
     * of agents that never matched the query. That path keeps its old window,
     * and its limits are the same as they were.
     */
    const scoped =
      !query && !!input.observationsForLiveness && !!input.statsAggregate && wanted.length > 0
    if (scoped && input.observationsForLiveness && input.statsAggregate) {
      const [observations, agg] = await Promise.all([
        input.observationsForLiveness(wanted),
        input.statsAggregate(),
      ])
      const ids = [...new Set(observations.map((o) => o.subject.agentId))]
      const results = ids
        .map((id) => projectPassport(id, observations))
        .filter((p) => wanted.includes(p.liveness))
      const limit = clampLimit(request.body.limit)

      // Counted over every row, so the honesty block agrees with /v1/stats
      // rather than with one page of it.
      const total = agg.indexed?.totalAgents ?? 0
      const unprobed = Math.max(0, total - agg.probed.agentsProbed)
      const exclusionReasons: Partial<Record<string, number>> = {}
      let excludedUnverified = 0
      const note = (state: string, count: number) => {
        if (count <= 0 || wanted.includes(state)) return
        exclusionReasons[state] = (exclusionReasons[state] ?? 0) + count
        if (state !== 'LIVE' && state !== 'DEGRADED') excludedUnverified += count
      }
      for (const [state, count] of Object.entries(agg.probed.byRawState)) note(state, count)
      note('UNPROBED', unprobed)

      return {
        results: results.slice(0, limit),
        total: results.length,
        coverage: {
          indexedAgents: total,
          // No query means everything indexed matched before the filter ran.
          matchedBeforeFilters: total,
          excludedUnverified,
          exclusionReasons,
        },
      }
    }

    const observations = await input.observations()
    const ids = [...new Set(observations.map((o) => o.subject.agentId))]
    const limit = clampLimit(request.body.limit)
    const matched = ids
      .map((id) => projectPassport(id, observations))
      .filter(
        (passport) =>
          !query ||
          passport.agentId.toLowerCase().includes(query) ||
          (passport.name?.toLowerCase().includes(query) ?? false) ||
          passport.liveness.toLowerCase().includes(query),
      )
    const kept = matched.filter((p) => wanted.includes(p.liveness))
    // The honesty block: what the filter removed, counted by why — and
    // excludedUnverified counts only the unverified among them, since a LIVE
    // agent removed by an explicit filter was excluded, not unverified.
    const exclusionReasons: Partial<Record<string, number>> = {}
    let excludedUnverified = 0
    for (const passport of matched) {
      if (wanted.includes(passport.liveness)) continue
      exclusionReasons[passport.liveness] = (exclusionReasons[passport.liveness] ?? 0) + 1
      if (passport.liveness !== 'LIVE' && passport.liveness !== 'DEGRADED') excludedUnverified += 1
    }
    return {
      results: kept.slice(0, limit),
      total: kept.length,
      coverage: {
        indexedAgents: ids.length,
        matchedBeforeFilters: matched.length,
        excludedUnverified,
        exclusionReasons,
      },
    }
  })
  app.post<{ Body: { agentId: string } }>('/v1/quotes', async (request, reply) => {
    const observations = await input.observations()
    const passport = projectPassport(request.body.agentId, observations)
    const fail = (code: string, message: string) =>
      reply.code(422).send({
        error: { code, message, retryable: false, requestId: request.headers['x-request-id'] },
      })

    if (passport.liveness !== 'LIVE')
      return fail('AGENT_NOT_QUOTABLE', 'Only LIVE agents may issue a marketplace quote.')

    const price = publishedPrice(request.body.agentId, observations)
    // A price we do not have is not a price of zero. Quoting free work that is
    // not free is the same class of mistake as reporting an unmeasured field as
    // a measurement, and this endpoint used to do exactly that.
    if (price === null)
      return fail(
        'AGENT_HAS_NO_PUBLISHED_PRICE',
        'This agent publishes no price in its registration, so there is nothing to quote.',
      )

    return buildQuote({ quoteId: randomUUID(), agentId: request.body.agentId, price })
  })
  app.post<{ Body: { constraints: Constraint[] } }>(
    '/v1/authorizations',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const authorization = await jobs.authorize(request.body.constraints, session.address)
      return { ...authorization, spent: authorization.spent.toString() }
    },
  )
  app.post<{ Params: { id: string } }>('/v1/authorizations/:id/revoke', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const existing = await jobs.getAuthorization(request.params.id)
    if (!requireOwner(request, reply, session, existing.owner, 'authorization')) return reply
    const authorization = await jobs.revoke(request.params.id)
    return { ...authorization, spent: authorization.spent.toString() }
  })
  app.post<{ Body: { authorizationId: string } }>('/v1/jobs', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const key = request.headers['idempotency-key']?.toString()
    if (!key)
      return reply.code(400).send({
        error: {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key is required.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    const authorization = await jobs.getAuthorization(request.body.authorizationId)
    if (!requireOwner(request, reply, session, authorization.owner, 'authorization')) return reply
    return jobs.createJob(request.body.authorizationId, key)
  })
  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    return ownedJob(request, reply, session.address, request.params.id)
  })
  app.get<{ Params: { id: string } }>('/v1/jobs/:id/events', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const job = await ownedJob(request, reply, session.address, request.params.id)
    if (!job) return reply
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    for (const event of job.events)
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    reply.raw.end()
    return reply
  })
  app.post<{ Params: { id: string } }>('/v1/jobs/:id/receipt', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const job = await ownedJob(request, reply, session.address, request.params.id)
    if (!job) return reply
    const authorization = await jobs.getAuthorization(job.authorizationId)
    return receipts.create({
      jobId: job.id,
      mandateHash: authorization.policy.hash,
      actions: job.events,
      startedAt: job.createdAt,
      completedAt: new Date().toISOString(),
    })
  })
  app.get<{ Params: { id: string } }>('/v1/receipts/:id', async (request) =>
    receipts.get(request.params.id),
  )
  // What a verifier pins: checking a receipt must not require trusting us.
  app.get('/v1/receipts/key', async () => ({
    alg: 'Ed25519',
    publicKey: receipts.publicKey(),
    profile: 'aiki-scitt-cose/v1',
  }))
  // A leaderboard anyone can write to is not a measurement, it is a guestbook.
  app.post<{ Body: Omit<BenchmarkRun, 'id' | 'completedAt' | 'methodology'> }>(
    '/v1/arena/runs',
    async (request, reply) => {
      if (!requireIngestToken(request, reply)) return reply
      return benchmarks.add(request.body)
    },
  )
  app.get<{ Params: { id: string } }>('/v1/arena/runs/:id', async (request) => {
    const run = benchmarks.get(request.params.id)
    return { ...run, evidence: benchmarkEvidence(run) }
  })
  app.get<{ Querystring: { agentId?: string } }>('/v1/arena/leaderboards', async (request) =>
    benchmarks
      .list()
      .filter((run) => !request.query.agentId || run.agentId === request.query.agentId)
      .map((run) => ({
        runId: run.id,
        agentId: run.agentId,
        scenarioId: run.scenarioId,
        ...benchmarkEvidence(run),
      })),
  )
  return app
}
