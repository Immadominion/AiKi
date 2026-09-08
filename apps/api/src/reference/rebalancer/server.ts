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
import type { PancakeReader } from './client.js'
import { persistPancakeAssessment } from './evidence-sink.js'

export type PancakeRebalancerConfig = ReferenceRegistrationConfig

const SPEC = {
  name: 'AiKi PancakeSwap LP Rebalancer',
  description:
    'First-party, read-only reference agent that verifies PancakeSwap v3 LP NFT range state and produces evidence-backed rebalance recommendations.',
  servicePath: '/v1/reference/pancake/rebalancer/agent',
  serviceName: 'pancakeswap-v3-lp-rebalance-assessment',
  iconPath: '/v1/reference/pancake/rebalancer/icon.svg',
}
export function createPancakeRebalancerServer(options: {
  reader: PancakeReader
  registration?: PancakeRebalancerConfig
  evidenceStore?: EvidenceStore
}) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const registration = options.registration
  const base = referenceBase(registration)
  app.get('/healthz', async () => ({ ok: true, service: 'aiki-pancakeswap-lp-rebalancer' }))
  app.get(SPEC.iconPath, async (_req, reply) =>
    reply
      .type('image/svg+xml')
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><path d="M20 26a14 14 0 0 1 24-4M44 38a14 14 0 0 1-24 4" fill="none" stroke="#f472b6" stroke-width="4" stroke-linecap="round"/><path d="M44 12v10H34M20 52V42h10" fill="none" stroke="#f472b6" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      ),
  )
  app.get('/v1/reference/pancake/rebalancer/manifest.json', async (_req, reply) =>
    registration && base
      ? referenceManifest(registration, SPEC)
      : reply.code(503).send(NOT_REGISTERED),
  )
  app.get('/.well-known/agent-registration.json', async (_req, reply) =>
    registration && base
      ? reciprocalProof([registration.agentId])
      : reply.code(503).send(NOT_REGISTERED),
  )
  app.get<{ Params: { agentId: string }; Querystring: { tokenId?: string } }>(
    '/v1/reference/pancake/rebalancer/agent/:agentId',
    async (request, reply) => {
      if (!registration || !base || request.params.agentId !== registration.agentId)
        return reply.code(404).send({
          error: {
            code: 'UNKNOWN_AGENT',
            message: 'This endpoint only serves the configured ERC-8004 LP Rebalancer identity.',
          },
        })
      if (request.query.tokenId === undefined)
        return {
          capability: 'pancakeswap-v3-lp-rebalance-assessment',
          category: 'rebalancing',
          input: { tokenId: 'PancakeSwap v3 position NFT integer' },
          output: 'Verified range state and read-only rebalance recommendation.',
          readOnly: true,
        }
      try {
        const assessment = await options.reader.assess(request.query.tokenId)
        const persisted = options.evidenceStore
          ? await persistPancakeAssessment(options.evidenceStore, {
              agentId: registration.agentId,
              assessment,
              registry: BSC_MAINNET.contracts.erc8004Identity,
              chainId: BSC_MAINNET.id,
            })
          : false
        return { assessment, evidence: { persisted } }
      } catch (error) {
        return reply.code(502).send({
          error: {
            code: 'PANCAKE_READ_FAILED',
            message:
              error instanceof Error ? error.message : 'Unable to read PancakeSwap v3 position.',
          },
        })
      }
    },
  )
  return app
}
