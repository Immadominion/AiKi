import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Constraint } from '../authority/policy.js'
import type { Observation } from '../evidence/types.js'
import { JobService } from '../jobs/service.js'
import { comparePassports, projectPassport } from '../projections/passport.js'
import { ReceiptService } from '../receipts/service.js'

export function createApiServer(input: {
  observations: () => Observation[]
  jobs?: JobService
  receipts?: ReceiptService
}) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const jobs = input.jobs ?? new JobService()
  const receipts = input.receipts ?? new ReceiptService()
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
    const observations = input.observations()
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
    projectPassport(request.params.agentId, input.observations()),
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
    const passports = request.body.agentIds.map((id) => projectPassport(id, input.observations()))
    return { agents: passports, ...comparePassports(passports) }
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
  return app
}
