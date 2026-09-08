import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Session } from './session.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the session hook; undefined means unauthenticated. */
    session?: Session | undefined
  }
}

/**
 * Everything that touches money or a mandate needs a proven address.
 *
 * Returns the session, or sends 401 and returns null. Callers must stop on null:
 * the reply has already been sent.
 */
export function requireSession(request: FastifyRequest, reply: FastifyReply): Session | null {
  if (request.session) return request.session
  reply.code(401).send({
    error: {
      code: 'UNAUTHENTICATED',
      message: 'Connect a wallet and sign in before using this.',
      retryable: false,
      requestId: request.headers['x-request-id'],
    },
  })
  return null
}

/**
 * Ownership is checked, never inferred.
 *
 * A record whose owner is null predates authentication and belongs to nobody, so
 * it is refused rather than handed to whoever asks first. The reply is a 404 in
 * both cases: telling a stranger that a mandate exists but is not theirs is
 * itself a disclosure.
 */
export function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  session: Session,
  owner: string | null | undefined,
  kind: string,
): boolean {
  if (owner && owner.toLowerCase() === session.address.toLowerCase()) return true
  reply.code(404).send({
    error: {
      code: 'NOT_FOUND',
      message: `No such ${kind}.`,
      retryable: false,
      requestId: request.headers['x-request-id'],
    },
  })
  return false
}
