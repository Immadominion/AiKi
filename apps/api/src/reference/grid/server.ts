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
import type { GridReader } from './client.js'
import { persistGridAssessment } from './evidence-sink.js'

const SPEC = {
  name: 'AiKi PancakeSwap Grid Trader',
  description:
    'First-party, read-only reference agent that verifies a PancakeSwap v3 grid configuration against live pool state and reports which rungs are in range. It recommends and never trades.',
  servicePath: '/v1/reference/pancake/grid/agent',
  serviceName: 'pancakeswap-v3-grid-assessment',
  iconPath: '/v1/reference/pancake/grid/icon.svg',
}

const CAPABILITY = {
  capability: SPEC.serviceName,
  category: 'grid_trading',
  input: {
    pool: 'v3 pool address',
    tickLower: 'integer',
    tickUpper: 'integer',
    spacing: 'integer',
  },
  readOnly: true,
}

export function createGridServer(options: {
  reader: GridReader
  registration?: ReferenceRegistrationConfig
  evidenceStore?: EvidenceStore
}) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const registration = options.registration
  const base = referenceBase(registration)
  const agentId = base ? registration?.agentId : undefined

  app.get('/healthz', async () => ({ ok: true, service: 'aiki-pancakeswap-grid-trader' }))
  app.get(SPEC.iconPath, async (_request, reply) =>
    reply
      .type('image/svg+xml')
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><g stroke="#57c1ff" stroke-width="3"><path d="M16 20h32M16 32h32M16 44h32M22 14v36M42 14v36"/></g></svg>',
      ),
  )
  app.get('/v1/reference/pancake/grid/manifest.json', async (_request, reply) =>
    registration && base
      ? referenceManifest(registration, SPEC)
      : reply.code(503).send(NOT_REGISTERED),
  )
  app.get('/.well-known/agent-registration.json', async (_request, reply) =>
    agentId ? reciprocalProof([agentId]) : reply.code(503).send(NOT_REGISTERED),
  )

  async function assess(
    query: { pool?: `0x${string}`; tickLower?: string; tickUpper?: string; spacing?: string },
    reply: { code(code: number): { send(value: unknown): unknown } },
  ) {
    const { pool, tickLower, tickUpper, spacing } = query
    if (!pool || !tickLower || !tickUpper || !spacing) return CAPABILITY
    try {
      const assessment = await options.reader.assess({
        pool,
        tickLower: Number(tickLower),
        tickUpper: Number(tickUpper),
        spacing: Number(spacing),
      })
      const persisted =
        agentId && options.evidenceStore
          ? (
              await persistGridAssessment(options.evidenceStore, {
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
          code: 'GRID_ASSESSMENT_FAILED',
          message: error instanceof Error ? error.message : 'Grid assessment failed.',
        },
      })
    }
  }

  /**
   * The registered endpoint carries the agent id, because that is the only shape
   * AiKi's own D1 rule can probe: it varies the last path segment and needs a
   * different answer for a different id. Serving every id the same bytes here is
   * precisely what `IMPOSTOR_STATIC` exists to catch, so refuse ids we do not own.
   */
  app.get<{
    Params: { agentId: string }
    Querystring: { pool?: `0x${string}`; tickLower?: string; tickUpper?: string; spacing?: string }
  }>(`${SPEC.servicePath}/:agentId`, async (request, reply) => {
    if (!agentId || request.params.agentId !== agentId)
      return reply.code(404).send({
        error: {
          code: 'UNKNOWN_AGENT',
          message: 'This endpoint only serves the configured ERC-8004 Grid Trader identity.',
        },
      })
    return assess(request.query, reply)
  })

  /** Kept so the standalone CLI and existing callers keep working, unregistered. */
  app.get<{
    Querystring: { pool?: `0x${string}`; tickLower?: string; tickUpper?: string; spacing?: string }
  }>('/v1/reference/pancake/grid', async (request, reply) => assess(request.query, reply))

  return app
}
