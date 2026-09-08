import Fastify from 'fastify'
import { type Address, isAddress } from 'viem'
import { BSC_MAINNET } from '../../config/chains.js'
import type { EvidenceStore } from '../../evidence/types.js'
import { persistVenusAssessment } from './evidence-sink.js'
import {
  type VenusRegistrationConfig,
  venusReciprocalProof,
  venusRegistration,
} from './registration.js'
import type { VenusHealthAssessment } from './types.js'

export interface VenusAssessmentReader {
  assess(account: Address, minimumHealthFactor?: string): Promise<VenusHealthAssessment>
}
export interface VenusReferenceServerOptions {
  reader: VenusAssessmentReader
  registration?: VenusRegistrationConfig
  evidenceStore?: EvidenceStore
}
function accountFrom(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value, { strict: false })
    ? (value as Address)
    : null
}

export function createVenusReferenceServer(options: VenusReferenceServerOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const registry = BSC_MAINNET.contracts.erc8004Identity
  app.get('/healthz', async () => ({ ok: true, service: 'aiki-venus-health-factor-guardian' }))
  app.get('/v1/reference/venus/icon.svg', async (_request, reply) =>
    reply
      .type('image/svg+xml')
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><path d="M32 8 12 20l20 36 20-36L32 8Z" fill="#f7c843"/></svg>',
      ),
  )
  app.get('/v1/reference/venus/manifest.json', async (_request, reply) => {
    if (!options.registration)
      return reply.code(503).send({
        error: {
          code: 'REFERENCE_NOT_REGISTERED',
          message:
            'This reference service is callable, but its public HTTPS URL and ERC-8004 token id have not been configured.',
        },
      })
    return venusRegistration(options.registration)
  })
  app.get('/.well-known/agent-registration.json', async (_request, reply) => {
    if (!options.registration)
      return reply.code(503).send({
        error: {
          code: 'REFERENCE_NOT_REGISTERED',
          message: 'Reciprocal proof is unavailable until ERC-8004 registration is configured.',
        },
      })
    return venusReciprocalProof(options.registration.agentId)
  })
  /**
   * Taking a piece of paid work, in the envelope AiKi's marketplace sends.
   *
   * The first implementation of that protocol, and it is AiKi's own agent
   * because it had to be somebody: a protocol with no implementers is a
   * document. Hiring this agent before this existed produced a 404, which was
   * an honest answer and a useless one.
   *
   * What it does here is exactly what it does everywhere else. It reads a Venus
   * position and reports the health factor with the evidence behind it. A brief
   * asking for anything else is DECLINED rather than answered badly, because
   * being paid for a confident wrong answer is worse for the person who hired
   * it than being told no, and the marketplace refunds a decline.
   */
  /**
   * A wei-denominated USD amount as something a person can read.
   *
   * Done in string arithmetic. These are eighteen-decimal values and putting one
   * through Number to print it loses its tail, on a number somebody is about to
   * make a decision with.
   */
  const usd = (amount: { amount: string; decimals: number }) => {
    const digits = amount.amount.padStart(amount.decimals + 1, '0')
    const whole = digits.slice(0, digits.length - amount.decimals)
    const cents = digits.slice(digits.length - amount.decimals).slice(0, 2)
    return `$${Number(whole).toLocaleString('en-US')}.${cents}`
  }

  app.post<{ Params: { agentId: string }; Body: { protocol?: string; brief?: string } }>(
    '/v1/reference/venus/agent/:agentId',
    async (request, reply) => {
      if (!options.registration || request.params.agentId !== options.registration.agentId)
        return reply.code(404).send({
          error: {
            code: 'UNKNOWN_AGENT',
            message: 'This endpoint only serves the configured ERC-8004 Venus Guardian identity.',
          },
        })
      if (request.body?.protocol !== 'aiki.task/v1')
        return reply.code(400).send({ error: 'This endpoint speaks aiki.task/v1.' })

      /*
       * The account to look at, taken from the brief.
       *
       * A deliberately narrow reading. This agent's whole value is that its
       * answer is a measurement, so it acts only on something unambiguous in
       * what it was asked, and says so plainly when there is nothing.
       */
      const account = accountFrom((request.body?.brief ?? '').match(/0x[0-9a-fA-F]{40}/)?.[0])
      if (!account)
        return {
          error:
            'I read Venus positions and report health factors. Name the account as a 0x address in the brief and I will assess it.',
        }

      try {
        const assessment = await options.reader.assess(account)
        if (options.evidenceStore)
          await persistVenusAssessment(options.evidenceStore, {
            agentId: options.registration.agentId,
            assessment,
            registry,
            chainId: BSC_MAINNET.id,
          })
        // Returned as text because the buyer reads it and decides whether to
        // pay for it. The numbers are the answer; the sentence is the receipt.
        /*
         * Written out rather than handed over as a blob, because a person is
         * about to read this and decide whether it was worth what they paid.
         * The methodology travels with the number: an unexplained health factor
         * is a claim, and this product does not sell claims.
         */
        return {
          result: [
            `Venus position for ${account}.`,
            `Health factor: ${assessment.healthFactor ?? 'no borrow, so none applies'}.`,
            `Status: ${assessment.status}.`,
            `Supplied ${usd(assessment.supplied)}, borrowed ${usd(assessment.borrowed)},`,
            `adjusted collateral ${usd(assessment.adjustedCollateral)}.`,
            `Read at ${assessment.observedAt} by ${assessment.methodology}.`,
            assessment.consistency.verified
              ? 'The controller agrees with the per-market sum.'
              : `Consistency check: ${assessment.consistency.detail}`,
          ].join(' '),
        }
      } catch (error) {
        return {
          error: `I could not read that position: ${
            error instanceof Error ? error.message : 'the chain did not answer'
          }`,
        }
      }
    },
  )

  app.get<{
    Params: { agentId: string }
    Querystring: { account?: string; minimumHealthFactor?: string }
  }>('/v1/reference/venus/agent/:agentId', async (request, reply) => {
    if (!options.registration || request.params.agentId !== options.registration.agentId)
      return reply.code(404).send({
        error: {
          code: 'UNKNOWN_AGENT',
          message: 'This endpoint only serves the configured ERC-8004 Venus Guardian identity.',
        },
      })
    if (request.query.account === undefined)
      return {
        capability: 'venus-health-factor-assessment',
        category: 'health_factor',
        input: {
          account: '0x-prefixed EVM address',
          minimumHealthFactor: 'optional decimal; default 1.25',
        },
        output: 'Evidence-backed Venus position health assessment.',
        readOnly: true,
      }
    const account = accountFrom(request.query.account)
    if (!account)
      return reply.code(400).send({
        error: {
          code: 'INVALID_ACCOUNT',
          message: 'account must be a valid 0x-prefixed EVM address.',
        },
      })
    try {
      const assessment = await options.reader.assess(account, request.query.minimumHealthFactor)
      const observationsInserted = options.evidenceStore
        ? await persistVenusAssessment(options.evidenceStore, {
            agentId: options.registration.agentId,
            assessment,
            registry,
            chainId: BSC_MAINNET.id,
          })
        : 0
      return {
        assessment,
        evidence: { observationsInserted, persisted: Boolean(options.evidenceStore) },
      }
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: 'VENUS_READ_FAILED',
          message: error instanceof Error ? error.message : 'Unable to read Venus position.',
        },
      })
    }
  })
  return app
}
