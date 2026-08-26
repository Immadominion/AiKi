import type { FastifyInstance } from 'fastify'
import type { PublicClient } from 'viem'
import {
  createSiweMessage,
  generateSiweNonce,
  parseSiweMessage,
  verifySiweMessage,
} from 'viem/siwe'
import type { NonceStore } from './nonce-store.js'
import { SESSION_COOKIE, type SessionSigner, serializeCookie } from './session.js'

const NONCE_TTL_SECONDS = 10 * 60
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

export interface AuthConfig {
  signer: SessionSigner
  nonces: NonceStore
  /**
   * Needed to verify smart-account signatures through ERC-1271. AiKi's whole
   * enforcement story runs on smart accounts, so refusing to authenticate one
   * would lock out exactly the users who matter most.
   */
  client: PublicClient
  /** The exact host the message must name, so a signature for another site cannot be replayed here. */
  domain: string
  /** Cookies are Secure everywhere except plain-http local development. */
  secureCookies: boolean
}

/**
 * Sign-In with Ethereum.
 *
 * The wallet proves control of an address by signing a message this server
 * issued, naming this domain, carrying a nonce this server can consume exactly
 * once. Anything less is a signature someone could have collected elsewhere.
 */
export function registerAuthRoutes(app: FastifyInstance, config: AuthConfig) {
  app.post('/v1/auth/nonce', async () => {
    const nonce = generateSiweNonce()
    await config.nonces.issue(nonce, NONCE_TTL_SECONDS)
    return { nonce, expiresInSeconds: NONCE_TTL_SECONDS }
  })

  app.post<{ Body: { message?: string; signature?: string } }>(
    '/v1/auth/verify',
    async (request, reply) => {
      const { message, signature } = request.body ?? {}
      const fail = (code: string, detail: string) =>
        reply.code(401).send({
          error: {
            code,
            message: detail,
            retryable: false,
            requestId: request.headers['x-request-id'],
          },
        })

      if (typeof message !== 'string' || typeof signature !== 'string')
        return fail('SIWE_MALFORMED', 'A signed message and its signature are required.')

      const parsed = parseSiweMessage(message)
      if (!parsed.address || !parsed.nonce || !parsed.chainId)
        return fail('SIWE_MALFORMED', 'The message is missing an address, nonce, or chain.')

      // The nonce is consumed before the signature is checked, so a wrong
      // signature still burns it and cannot be retried against the same nonce.
      if (!(await config.nonces.consume(parsed.nonce)))
        return fail('SIWE_NONCE_INVALID', 'That nonce is unknown, expired, or already used.')

      let valid = false
      try {
        valid = await verifySiweMessage(config.client, {
          message,
          signature: signature as `0x${string}`,
          domain: config.domain,
          nonce: parsed.nonce,
        })
      } catch {
        valid = false
      }
      if (!valid)
        return fail('SIWE_SIGNATURE_INVALID', 'That signature does not match the message.')

      const address = parsed.address.toLowerCase()
      const token = config.signer.issue(address, parsed.chainId, SESSION_TTL_SECONDS)
      reply.header(
        'set-cookie',
        serializeCookie(SESSION_COOKIE, token, {
          maxAge: SESSION_TTL_SECONDS,
          secure: config.secureCookies,
        }),
      )
      return { address, chainId: parsed.chainId }
    },
  )

  app.post('/v1/auth/logout', async (_request, reply) => {
    reply.header(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: config.secureCookies }),
    )
    return { ok: true }
  })

  app.get('/v1/auth/me', async (request, reply) => {
    const session = request.session
    if (!session)
      return reply.code(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'No valid session.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    return { address: session.address, chainId: session.chainId }
  })
}

/** The exact message the frontend should ask the wallet to sign. */
export function buildSiweMessage(input: {
  domain: string
  address: `0x${string}`
  uri: string
  chainId: number
  nonce: string
}) {
  return createSiweMessage({
    domain: input.domain,
    address: input.address,
    statement:
      'Sign in to AiKi. This proves you control this address. It grants no permission to move funds.',
    uri: input.uri,
    version: '1',
    chainId: input.chainId,
    nonce: input.nonce,
  })
}
