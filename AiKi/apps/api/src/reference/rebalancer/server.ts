import Fastify from 'fastify'
import { BSC_MAINNET } from '../../config/chains.js'
import type { EvidenceStore } from '../../evidence/types.js'
import { REGISTRATION_TYPE } from '../../prober/registration.js'
import { persistPancakeAssessment } from './evidence-sink.js'
import type { PancakeReader } from './client.js'

export interface PancakeRebalancerConfig { publicBaseUrl: string; agentId: string }
export function createPancakeRebalancerServer(options: { reader: PancakeReader; registration?: PancakeRebalancerConfig; evidenceStore?: EvidenceStore }) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const registration = options.registration
  const base = registration ? new URL(registration.publicBaseUrl).toString().replace(/\/$/, '') : null
  const registry = `eip155:${BSC_MAINNET.id}:${BSC_MAINNET.contracts.erc8004Identity}`
  app.get('/healthz', async () => ({ ok: true, service: 'aiki-pancakeswap-lp-rebalancer' }))
  app.get('/v1/reference/pancake/rebalancer/manifest.json', async (_req, reply) => {
    if (!registration || !base || !/^\d+$/.test(registration.agentId) || !base.startsWith('https://')) return reply.code(503).send({ error: { code: 'REFERENCE_NOT_REGISTERED', message: 'Public HTTPS URL and ERC-8004 token id are required before publishing a registration manifest.' } })
    return { type: REGISTRATION_TYPE, name: 'AiKi PancakeSwap LP Rebalancer', description: 'First-party, read-only reference agent that verifies PancakeSwap v3 LP NFT range state and produces evidence-backed rebalance recommendations.', image: `${base}/v1/reference/pancake/rebalancer/icon.svg`, active: true, services: [{ name: 'pancakeswap-v3-lp-rebalance-assessment', endpoint: `${base}/v1/reference/pancake/rebalancer/agent/${registration.agentId}`, version: '1.0.0' }], registrations: [{ agentId: registration.agentId, agentRegistry: registry }], supportedTrust: [] }
  })
  app.get('/.well-known/agent-registration.json', async (_req, reply) => {
    if (!registration) return reply.code(503).send({ error: { code: 'REFERENCE_NOT_REGISTERED', message: 'Reciprocal proof unavailable until configured.' } })
    return { registrations: [{ agentId: registration.agentId, agentRegistry: registry }] }
  })
  app.get<{ Params: { agentId: string }; Querystring: { tokenId?: string } }>('/v1/reference/pancake/rebalancer/agent/:agentId', async (request, reply) => {
    if (!registration || request.params.agentId !== registration.agentId) return reply.code(404).send({ error: { code: 'UNKNOWN_AGENT', message: 'This endpoint only serves the configured ERC-8004 LP Rebalancer identity.' } })
    if (request.query.tokenId === undefined) return { capability: 'pancakeswap-v3-lp-rebalance-assessment', category: 'rebalancing', input: { tokenId: 'PancakeSwap v3 position NFT integer' }, output: 'Verified range state and read-only rebalance recommendation.', readOnly: true }
    try {
      const assessment = await options.reader.assess(request.query.tokenId)
      const persisted = options.evidenceStore ? await persistPancakeAssessment(options.evidenceStore, { agentId: registration.agentId, assessment, registry: BSC_MAINNET.contracts.erc8004Identity, chainId: BSC_MAINNET.id }) : false
      return { assessment, evidence: { persisted } }
    } catch (error) { return reply.code(502).send({ error: { code: 'PANCAKE_READ_FAILED', message: error instanceof Error ? error.message : 'Unable to read PancakeSwap v3 position.' } }) }
  })
  return app
}
