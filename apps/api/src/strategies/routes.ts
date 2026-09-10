import type { FastifyInstance } from 'fastify'
import type { Hex } from 'viem'
import { requireSession } from '../auth/guard.js'
import { ClientError } from '../http/errors.js'
import type { StrategySetupService } from './setup.js'

const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new ClientError('No such strategy setup.', { statusCode: 404, code: 'NOT_FOUND' })
  return value
}
const key = (value: unknown) => {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,160}$/.test(value))
    throw new ClientError('Idempotency-Key is required for this reviewed wallet intent.')
  return value
}

/** Authentication comes from the existing SIWE session hook, never a body owner address. */
export type StrategyRoutesService = Pick<
  StrategySetupService,
  | 'publicConfig'
  | 'list'
  | 'prepare'
  | 'get'
  | 'prepareAction'
  | 'submitAction'
  | 'finalizeAction'
  | 'prepareAuthorization'
  | 'fileAuthorization'
  | 'start'
  | 'pause'
  | 'recover'
>
export function registerStrategyRoutes(app: FastifyInstance, service: StrategyRoutesService): void {
  app.get('/v1/strategies/config', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.publicConfig()
  })
  app.get('/v1/strategies', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const session = requireSession(request, reply)
    if (!session) return reply
    return service.list(session.address as Hex)
  })
  app.post<{ Body: unknown }>(
    '/v1/strategies/prepare',
    { bodyLimit: 32_768 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = requireSession(request, reply)
      if (!session) return reply
      return service.prepare(
        session.address as Hex,
        request.body,
        key(request.headers['idempotency-key']),
      )
    },
  )
  app.get<{ Params: { id: string } }>('/v1/strategies/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const session = requireSession(request, reply)
    if (!session) return reply
    return service.get(session.address as Hex, uuid(request.params.id))
  })
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/strategies/:id/actions/prepare',
    { bodyLimit: 4096 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = requireSession(request, reply)
      if (!session) return reply
      return service.prepareAction(
        session.address as Hex,
        uuid(request.params.id),
        request.body,
        key(request.headers['idempotency-key']),
      )
    },
  )
  app.post<{ Params: { id: string; actionId: string }; Body: unknown }>(
    '/v1/strategies/:id/actions/:actionId/submit',
    { bodyLimit: 1024 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = requireSession(request, reply)
      if (!session) return reply
      return service.submitAction(
        session.address as Hex,
        uuid(request.params.id),
        uuid(request.params.actionId),
        request.body,
      )
    },
  )
  app.post<{ Params: { id: string; actionId: string } }>(
    '/v1/strategies/:id/actions/:actionId/finalize',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = requireSession(request, reply)
      if (!session) return reply
      if (request.body !== undefined && request.body !== null)
        throw new ClientError('Finalization uses only the previously recorded transaction hash.')
      return service.finalizeAction(
        session.address as Hex,
        uuid(request.params.id),
        uuid(request.params.actionId),
      )
    },
  )
  app.post<{ Params: { id: string } }>(
    '/v1/strategies/:id/authorization/prepare',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = requireSession(request, reply)
      if (!session) return reply
      if (request.body !== undefined && request.body !== null)
        throw new ClientError(
          'Authority is derived from the stored reviewed strategy, not request fields.',
        )
      return service.prepareAuthorization(session.address as Hex, uuid(request.params.id))
    },
  )
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/strategies/:id/authorization',
    { bodyLimit: 1024 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const session = requireSession(request, reply)
      if (!session) return reply
      return service.fileAuthorization(
        session.address as Hex,
        uuid(request.params.id),
        request.body,
      )
    },
  )
  for (const operation of ['start', 'pause', 'recover'] as const)
    app.post<{ Params: { id: string } }>(
      `/v1/strategies/:id/${operation}`,
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store')
        const session = requireSession(request, reply)
        if (!session) return reply
        if (request.body !== undefined && request.body !== null)
          throw new ClientError(
            'This operation uses only the owner’s stored strategy configuration.',
          )
        return service[operation](session.address as Hex, uuid(request.params.id))
      },
    )
}
