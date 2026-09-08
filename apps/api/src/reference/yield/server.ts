import Fastify from 'fastify'
import { BSC_MAINNET } from '../../config/chains.js'
import type { EvidenceStore } from '../../evidence/types.js'
import {
  NOT_REGISTERED,
  type ReferenceRegistrationConfig,
  reciprocalProof,
  referenceBase,
  referenceManifest,
} from '../manifest.js'
import type { YieldReader } from './client.js'
import { persistYieldAssessment } from './evidence-sink.js'

const SPEC = {
  name: 'AiKi Venus Yield Optimiser',
  description:
    'First-party, read-only reference agent that reads live Venus supply rates across markets and reports where capital would earn most. It reports a route and never moves funds.',
  servicePath: '/v1/reference/yield/agent',
  serviceName: 'venus-yield-route-assessment',
  iconPath: '/v1/reference/yield/icon.svg',
}

const CAPABILITY = {
  capability: SPEC.serviceName,
  category: 'yield_optimisation',
  input: {
    markets: 'comma-separated Venus market addresses',
    rateOnly: 'optional true; remains explicitly non-optimising',
  },
  readOnly: true,
}

export function createYieldServer(options: {
  reader: YieldReader
  registration?: ReferenceRegistrationConfig
  evidenceStore?: EvidenceStore
}) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const registration = options.registration
  const base = referenceBase(registration)
  const agentId = base ? registration?.agentId : undefined

  app.get('/healthz', async () => ({ ok: true, service: 'aiki-yield-optimizer' }))
  app.get(SPEC.iconPath, async (_request, reply) =>
    reply
      .type('image/svg+xml')
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><path d="M14 44l12-12 9 8 15-18" fill="none" stroke="#4ade80" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 22h10v10" fill="none" stroke="#4ade80" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      ),
  )
  app.get('/v1/reference/yield/manifest.json', async (_request, reply) =>
    registration && base
      ? referenceManifest(registration, SPEC)
      : reply.code(503).send(NOT_REGISTERED),
  )
  app.get('/.well-known/agent-registration.json', async (_request, reply) =>
    agentId ? reciprocalProof([agentId]) : reply.code(503).send(NOT_REGISTERED),
  )

  async function assess(
    query: { markets?: string; rateOnly?: string },
    reply: { code(code: number): { send(value: unknown): unknown } },
  ) {
    const markets = query.markets?.split(',').filter(Boolean) as `0x${string}`[] | undefined
    if (!markets?.length) return CAPABILITY
    try {
      const assessment = await options.reader.assess(markets, query.rateOnly === 'true')
      const persisted =
        agentId && options.evidenceStore
          ? (
              await persistYieldAssessment(options.evidenceStore, {
                agentId,
                assessment,
                registry: BSC_MAINNET.contracts.erc8004Identity,
                chainId: BSC_MAINNET.id,
              })
            ).inserted
          : false
      return { assessment, evidence: { persisted } }
    } catch (error) {
      return reply.code(400).send({
        error: {
          code: 'YIELD_ASSESSMENT_FAILED',
          message: error instanceof Error ? error.message : 'Yield assessment failed.',
        },
      })
    }
  }

  /** Identity-bound, for the same reason as the grid agent: D1 must be able to run. */
  app.get<{
    Params: { agentId: string }
    Querystring: { markets?: string; rateOnly?: string }
  }>(`${SPEC.servicePath}/:agentId`, async (request, reply) => {
    if (!agentId || request.params.agentId !== agentId)
      return reply.code(404).send({
        error: {
          code: 'UNKNOWN_AGENT',
          message: 'This endpoint only serves the configured ERC-8004 Yield Optimiser identity.',
        },
      })
    return assess(request.query, reply)
  })

  /** Kept so the standalone CLI and existing callers keep working, unregistered. */
  app.get<{ Querystring: { markets?: string; rateOnly?: string } }>(
    '/v1/reference/yield',
    async (request, reply) => assess(request.query, reply),
  )

  return app
}
