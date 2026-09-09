import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth/guard.js'
import { ClientError } from '../http/errors.js'
import type { ConversationStore } from './conversations.js'

export function registerConversationRoutes(app: FastifyInstance, store: ConversationStore) {
  app.get<{ Querystring: { before?: string } }>(
    '/v1/assistant/conversations',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      return store.list(session.address, request.query.before)
    },
  )
  app.post<{ Body: { id?: string } }>('/v1/assistant/conversations', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    return store.create(session.address, request.body?.id ?? '')
  })
  app.get<{ Params: { id: string } }>('/v1/assistant/conversations/:id', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const conversation = await store.get(session.address, request.params.id)
    if (!conversation)
      throw new ClientError('This conversation is not available for your wallet.', {
        code: 'CONVERSATION_NOT_FOUND',
        statusCode: 404,
      })
    return conversation
  })
}
