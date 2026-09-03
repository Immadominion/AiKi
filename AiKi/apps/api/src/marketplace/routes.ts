import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireSession } from '../auth/guard.js'
import { hashCanonicalJson } from './canonical-json.js'
import { MarketplaceError } from './errors.js'
import type { ActorIdentity, JsonValue } from './model.js'
import { decodeCursor } from './pagination.js'
import { MARKETPLACE_POLICY } from './policy.js'
import { buildJobPreview, normalizePreviewJob } from './preview.js'
import type { MarketplaceStore } from './store.js'
import {
  normalizeAddress,
  normalizeCreateJob,
  normalizeOffer,
  normalizeProvider,
  normalizeSubmitJob,
  requireIdempotencyKey,
} from './validation.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const pageLimit = (value: unknown): number => {
  if (value === undefined) return 24
  const limit = typeof value === 'string' ? Number(value) : value
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
    throw new MarketplaceError('INVALID_PAGE_LIMIT', 'limit must be an integer from 1 to 100.')
  return limit as number
}

const routeId = (value: string, kind: string): string => {
  if (!UUID.test(value))
    throw new MarketplaceError('NOT_FOUND', `No such ${kind}.`, { statusCode: 404 })
  return value
}

const identity = (request: FastifyRequest, reply: FastifyReply): ActorIdentity | null => {
  const session = requireSession(request, reply)
  if (!session) return null
  if (!Number.isSafeInteger(session.chainId) || session.chainId < 1)
    throw new MarketplaceError('INVALID_SESSION', 'Sign in again with a valid chain.', {
      statusCode: 401,
    })
  return {
    chainId: session.chainId,
    address: normalizeAddress(session.address),
  }
}

const idempotency = (request: FastifyRequest, normalized: JsonValue) => ({
  key: requireIdempotencyKey(request.headers['idempotency-key']),
  requestHash: hashCanonicalJson(normalized),
})

const sendCommand = <T>(
  reply: FastifyReply,
  result: { body: T; statusCode: number; replayed: boolean },
) => {
  reply.header('idempotency-replayed', result.replayed ? 'true' : 'false')
  return reply.code(result.statusCode).send(result.body)
}

export function registerMarketplaceRoutes(app: FastifyInstance, store: MarketplaceStore): void {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/v2/providers', async (request) =>
    store.listProviders(pageLimit(request.query.limit), decodeCursor(request.query.cursor)),
  )

  app.get<{ Params: { id: string } }>('/v2/providers/:id', async (request, reply) => {
    const provider = await store.getProvider(routeId(request.params.id, 'provider'))
    if (!provider)
      return reply.code(404).send({
        error: { code: 'PROVIDER_NOT_FOUND', message: 'No such provider.', retryable: false },
      })
    return provider
  })

  app.put<{ Body: unknown }>('/v2/providers/me', async (request, reply) => {
    const actor = identity(request, reply)
    if (!actor) return reply
    const normalized = normalizeProvider(request.body)
    return sendCommand(
      reply,
      await store.putProvider(
        actor,
        normalized,
        idempotency(request, normalized as unknown as JsonValue),
      ),
    )
  })

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/v2/offers', async (request) =>
    store.listOffers(pageLimit(request.query.limit), decodeCursor(request.query.cursor)),
  )

  app.get<{ Params: { id: string } }>('/v2/offers/:id', async (request, reply) => {
    const offer = await store.getOffer(routeId(request.params.id, 'offer'))
    if (!offer)
      return reply.code(404).send({
        error: { code: 'OFFER_NOT_FOUND', message: 'No such offer.', retryable: false },
      })
    return offer
  })

  app.post<{ Body: unknown }>('/v2/offers', async (request, reply) => {
    const actor = identity(request, reply)
    if (!actor) return reply
    const normalized = normalizeOffer(request.body, MARKETPLACE_POLICY.platformFeeBps)
    return sendCommand(
      reply,
      await store.createOffer(
        actor,
        normalized,
        idempotency(request, normalized as unknown as JsonValue),
      ),
    )
  })

  app.post<{ Params: { id: string } }>('/v2/offers/:id/pause', async (request, reply) => {
    const actor = identity(request, reply)
    if (!actor) return reply
    const offerId = routeId(request.params.id, 'offer')
    return sendCommand(
      reply,
      await store.pauseOffer(
        actor,
        offerId,
        idempotency(request, { offerId } as unknown as JsonValue),
      ),
    )
  })

  app.post<{ Body: unknown }>('/v2/jobs/preview', async (request, reply) => {
    const normalized = normalizePreviewJob(request.body)
    const offer = await store.getOffer(routeId(normalized.offerId, 'offer'))
    if (!offer)
      return reply.code(404).send({
        error: { code: 'OFFER_NOT_FOUND', message: 'No such offer.', retryable: false },
      })
    return buildJobPreview(offer, normalized)
  })

  app.post<{ Body: unknown }>('/v2/jobs', async (request, reply) => {
    const actor = identity(request, reply)
    if (!actor) return reply
    const normalized = normalizeCreateJob(request.body)
    routeId(normalized.offerId, 'offer')
    return sendCommand(
      reply,
      await store.createJob(
        actor,
        normalized,
        idempotency(request, normalized as unknown as JsonValue),
      ),
    )
  })

  app.post<{ Params: { id: string } }>('/v2/jobs/:id/start', async (request, reply) => {
    const actor = identity(request, reply)
    if (!actor) return reply
    const jobId = routeId(request.params.id, 'job')
    return sendCommand(
      reply,
      await store.startJob(actor, jobId, idempotency(request, { jobId } as unknown as JsonValue)),
    )
  })

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v2/jobs/:id/submissions',
    async (request, reply) => {
      const actor = identity(request, reply)
      if (!actor) return reply
      const jobId = routeId(request.params.id, 'job')
      const normalized = normalizeSubmitJob(request.body)
      return sendCommand(
        reply,
        await store.submitJob(
          actor,
          jobId,
          normalized,
          idempotency(request, { jobId, ...normalized } as unknown as JsonValue),
        ),
      )
    },
  )
}
