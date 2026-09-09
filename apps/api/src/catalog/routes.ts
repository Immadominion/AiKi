import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireSession } from '../auth/guard.js'
import { WindowBudget } from './bounds.js'
import { CatalogService, validateId, validateQuery } from './service.js'
import { CatalogError, object } from './types.js'

/** Register after the existing session hook. Never supply a separate cookie parser. */
export function registerCatalogRoutes(
  app: FastifyInstance,
  service = new CatalogService({
    apiKey: process.env.EIGHT004SCAN_API_KEY ?? '',
    sourceRequestsPerMinute: process.env.CATALOG_SOURCE_REQUESTS_PER_MINUTE ?? '',
    sourceRequestsPerDay: process.env.CATALOG_SOURCE_REQUESTS_PER_DAY ?? '',
  }),
): void {
  const publicBudget = new WindowBudget(40, 60_000)
  const discoveryBudget = new WindowBudget(6, 60_000)
  const readBudget = new WindowBudget(6, 60_000)
  const activeReads = new Set<string>()
  const handle =
    (fn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store')
      try {
        return await fn(request, reply)
      } catch (error) {
        const known = error instanceof CatalogError
        const status = known ? error.status : 502
        if (known && error.retryAfter) reply.header('retry-after', String(error.retryAfter))
        return reply.code(status).send({
          error: {
            code: known ? error.code : 'CATALOG_UNAVAILABLE',
            message: known ? error.message : 'The external provider is temporarily unavailable.',
            retryable: status >= 500 || status === 429,
          },
        })
      }
    }
  app.get(
    '/v1/catalog/agents',
    handle(async (request) => {
      publicBudget.take(request.ip)
      return service.list(validateQuery(object(request.query)))
    }),
  )
  app.get(
    '/v1/catalog/agents/:id',
    handle(async (request) => {
      publicBudget.take(request.ip)
      return service.detail(validateId(String(object(request.params).id)))
    }),
  )
  app.get(
    '/v1/catalog/agents/:id/capabilities',
    handle(async (request) => {
      discoveryBudget.take(request.ip)
      return service.capabilities(validateId(String(object(request.params).id)))
    }),
  )
  app.post(
    '/v1/catalog/agents/:id/read',
    { bodyLimit: 4096 },
    handle(async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return
      // Required here: a cookie alone must not dispatch under another tab's wallet.
      if (typeof request.headers['x-aiki-wallet-address'] !== 'string')
        throw new CatalogError(
          401,
          'WALLET_SESSION_CHANGED',
          'Sign in with the selected wallet before using this agent.',
        )
      const id = validateId(String(object(request.params).id))
      const body = object(request.body)
      if (
        Object.keys(body).some((key) => key !== 'tool' && key !== 'arguments') ||
        typeof body.tool !== 'string' ||
        body.tool.length > 128 ||
        !body.arguments ||
        Array.isArray(body.arguments) ||
        typeof body.arguments !== 'object'
      )
        throw new CatalogError(
          400,
          'INVALID_TOOL_ARGUMENTS',
          'Provide a supported tool and its arguments.',
        )
      const wallet = session.address.toLowerCase()
      readBudget.take(wallet)
      if (activeReads.has(wallet) || activeReads.size >= 4)
        throw new CatalogError(429, 'READ_IN_PROGRESS', 'Wait for the current read to finish.', 5)
      activeReads.add(wallet)
      try {
        return await service.read(id, body.tool, body.arguments, wallet)
      } finally {
        activeReads.delete(wallet)
      }
    }),
  )
}
