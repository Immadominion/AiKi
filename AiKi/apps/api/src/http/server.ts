import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Constraint } from '../authority/policy.js'
import { type BenchmarkRun, BenchmarkService, benchmarkEvidence } from '../benchmarks/service.js'
import type { Observation } from '../evidence/types.js'
import { parseIntent } from '../intent/parser.js'
import { JobService } from '../jobs/service.js'
import { comparePassports, projectPassport } from '../projections/passport.js'
import { ReceiptService } from '../receipts/service.js'

export function createApiServer(input: {
  observations: () => Observation[] | Promise<Observation[]>
  jobs?: JobService
  receipts?: ReceiptService
  benchmarks?: BenchmarkService
}) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const jobs = input.jobs ?? new JobService()
  const receipts = input.receipts ?? new ReceiptService()
  const benchmarks = input.benchmarks ?? new BenchmarkService()
  app.addHook('onRequest', async (request, reply) => {
    const id = request.headers['x-request-id']?.toString() ?? randomUUID()
    request.headers['x-request-id'] = id
    reply.header('x-request-id', id)
  })
  app.setErrorHandler((error, request, reply) =>
    reply.code(400).send({
      error: {
        code: 'BAD_REQUEST',
        message: error instanceof Error ? error.message : 'Request failed.',
        retryable: false,
        requestId: request.headers['x-request-id'],
      },
    }),
  )
  app.get('/v1/stats', async () => {
    const observations = await input.observations()
    const verdicts = observations.filter((o) => o.predicate === 'agent.liveness_verdict')
    return {
      indexedAgents: new Set(observations.map((o) => o.subject.agentId)).size,
      observations: observations.length,
      liveness: Object.fromEntries(
        verdicts.reduce((out, row) => {
          const state = String(row.value.state ?? 'UNPROBED')
          out.set(state, (out.get(state) ?? 0) + 1)
          return out
        }, new Map<string, number>()),
      ),
    }
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
    const observations = await input.observations()
    const ids = [...new Set(observations.map((o) => o.subject.agentId))]
    const query = request.body.query?.toLowerCase()
    const limit = Math.min(Math.max(request.body.limit ?? 20, 1), 100)
    const results = ids
      .map((id) => projectPassport(id, observations))
      .filter(
        (passport) =>
          !query ||
          passport.agentId.toLowerCase().includes(query) ||
          passport.liveness.toLowerCase().includes(query),
      )
      .filter(
        (passport) =>
          !request.body.filters?.liveness ||
          request.body.filters.liveness.includes(passport.liveness),
      )
      .slice(0, limit)
    return {
      results,
      total: results.length,
      coverage: {
        indexedAgents: ids.length,
        matchedBeforeFilters: ids.length,
        excludedUnverified: ids.length - results.length,
        exclusionReasons: {},
      },
    }
  })
  app.post<{ Body: { agentId: string } }>('/v1/quotes', async (request, reply) => {
    const passport = projectPassport(request.body.agentId, await input.observations())
    if (passport.liveness !== 'LIVE')
      return reply.code(422).send({
        error: {
          code: 'AGENT_NOT_QUOTABLE',
          message: 'Only LIVE agents may issue a marketplace quote.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    return {
      quoteId: randomUUID(),
      agentId: request.body.agentId,
      price: { amount: '0', asset: 'U', decimals: 18 },
      platformFee: { amount: '0', asset: 'U', decimals: 18 },
      estimatedGas: { amount: '0', asset: 'BNB', decimals: 18 },
      expiresAt,
      protocol: 'offchain',
      caveat: 'Reference-agent assessment quote; no settlement is requested.',
    }
  })
  app.post<{ Body: { constraints: Constraint[] } }>('/v1/authorizations', async (request) => {
    const authorization = jobs.authorize(request.body.constraints)
    return { ...authorization, spent: authorization.spent.toString() }
  })
  app.post<{ Params: { id: string } }>('/v1/authorizations/:id/revoke', async (request) => {
    const authorization = jobs.revoke(request.params.id)
    return { ...authorization, spent: authorization.spent.toString() }
  })
  app.post<{ Body: { authorizationId: string } }>('/v1/jobs', async (request, reply) => {
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
    return jobs.createJob(request.body.authorizationId, key)
  })
  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request) =>
    jobs.getJob(request.params.id),
  )
  app.get<{ Params: { id: string } }>('/v1/jobs/:id/events', async (request, reply) => {
    const job = jobs.getJob(request.params.id)
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
  app.post<{ Params: { id: string } }>('/v1/jobs/:id/receipt', async (request) => {
    const job = jobs.getJob(request.params.id)
    return receipts.create({
      jobId: job.id,
      mandateHash: jobs.getAuthorization(job.authorizationId).policy.hash,
      actions: job.events,
      startedAt: job.createdAt,
      completedAt: new Date().toISOString(),
    })
  })
  app.get<{ Params: { id: string } }>('/v1/receipts/:id', async (request) =>
    receipts.get(request.params.id),
  )
  app.post<{ Body: Omit<BenchmarkRun, 'id' | 'completedAt' | 'methodology'> }>(
    '/v1/arena/runs',
    async (request) => benchmarks.add(request.body),
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
