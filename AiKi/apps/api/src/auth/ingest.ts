import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * The gate on first-party write endpoints.
 *
 * Benchmark runs are produced by AiKi's own harness, not by a browser, so a
 * wallet session is the wrong shape for them: there is no user to sign in. A
 * bearer token is.
 *
 * It fails CLOSED. With no token configured the endpoint refuses everything,
 * because the alternative — an open write path into a leaderboard AiKi presents
 * as measured — lets anyone publish a number under our name, which is the exact
 * claim this product exists to make trustworthy.
 */
export function requireIngestToken(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = process.env.ARENA_INGEST_TOKEN
  if (!expected) {
    reply.code(503).send({
      error: {
        code: 'INGEST_DISABLED',
        message: 'Benchmark ingestion is not configured on this deployment.',
        retryable: false,
        requestId: request.headers['x-request-id'],
      },
    })
    return false
  }

  const header = request.headers.authorization
  const presented = typeof header === 'string' ? header.replace(/^Bearer /i, '') : ''
  // Compare over fixed-size buffers so the check cannot leak the token's length.
  const a = Buffer.from(presented.padEnd(64).slice(0, 64))
  const b = Buffer.from(expected.padEnd(64).slice(0, 64))
  if (presented.length !== expected.length || !timingSafeEqual(a, b)) {
    reply.code(401).send({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'This endpoint requires a benchmark ingestion token.',
        retryable: false,
        requestId: request.headers['x-request-id'],
      },
    })
    return false
  }
  return true
}
