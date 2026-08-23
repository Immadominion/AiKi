import Fastify from 'fastify'
import { isAddress, type Address } from 'viem'
import { BSC_MAINNET } from '../../config/chains.js'
import type { EvidenceStore } from '../../evidence/types.js'
import { persistVenusAssessment } from './evidence-sink.js'
import { venusReciprocalProof, venusRegistration, type VenusRegistrationConfig } from './registration.js'
import type { VenusHealthAssessment } from './types.js'

export interface VenusAssessmentReader { assess(account: Address, minimumHealthFactor?: string): Promise<VenusHealthAssessment> }
export interface VenusReferenceServerOptions { reader: VenusAssessmentReader; registration?: VenusRegistrationConfig; evidenceStore?: EvidenceStore }
function accountFrom(value: unknown): Address | null { return typeof value === 'string' && isAddress(value, { strict: false }) ? value as Address : null }

export function createVenusReferenceServer(options: VenusReferenceServerOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  const registry = BSC_MAINNET.contracts.erc8004Identity
  app.get('/healthz', async () => ({ ok: true, service: 'aiki-venus-health-factor-guardian' }))
  app.get('/v1/reference/venus/icon.svg', async (_request, reply) => reply.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><path d="M32 8 12 20l20 36 20-36L32 8Z" fill="#f7c843"/></svg>'))
  app.get('/v1/reference/venus/manifest.json', async (_request, reply) => {
    if (!options.registration) return reply.code(503).send({ error: { code: 'REFERENCE_NOT_REGISTERED', message: 'This reference service is callable, but its public HTTPS URL and ERC-8004 token id have not been configured.' } })
    return venusRegistration(options.registration)
  })
  app.get('/.well-known/agent-registration.json', async (_request, reply) => {
    if (!options.registration) return reply.code(503).send({ error: { code: 'REFERENCE_NOT_REGISTERED', message: 'Reciprocal proof is unavailable until ERC-8004 registration is configured.' } })
    return venusReciprocalProof(options.registration.agentId)
  })
  app.get<{ Params: { agentId: string }; Querystring: { account?: string; minimumHealthFactor?: string } }>('/v1/reference/venus/agent/:agentId', async (request, reply) => {
    if (!options.registration || request.params.agentId !== options.registration.agentId) return reply.code(404).send({ error: { code: 'UNKNOWN_AGENT', message: 'This endpoint only serves the configured ERC-8004 Venus Guardian identity.' } })
    if (request.query.account === undefined) return { capability: 'venus-health-factor-assessment', category: 'health_factor', input: { account: '0x-prefixed EVM address', minimumHealthFactor: 'optional decimal; default 1.25' }, output: 'Evidence-backed Venus position health assessment.', readOnly: true }
    const account = accountFrom(request.query.account)
    if (!account) return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT', message: 'account must be a valid 0x-prefixed EVM address.' } })
    try {
      const assessment = await options.reader.assess(account, request.query.minimumHealthFactor)
      const observationsInserted = options.evidenceStore ? await persistVenusAssessment(options.evidenceStore, { agentId: options.registration.agentId, assessment, registry, chainId: BSC_MAINNET.id }) : 0
      return { assessment, evidence: { observationsInserted, persisted: Boolean(options.evidenceStore) } }
    } catch (error) {
      return reply.code(502).send({ error: { code: 'VENUS_READ_FAILED', message: error instanceof Error ? error.message : 'Unable to read Venus position.' } })
    }
  })
  return app
}
