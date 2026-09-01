/**
 * The one place a first-party ERC-8004 registration file is built.
 *
 * AiKi grades other people's agents. Its own must be gradeable by the same rules,
 * and two of those rules constrain the manifest before it is ever published:
 *
 *  - D1 (prober/detect.ts) can only run if the declared endpoint carries an
 *    identifier the prober can vary, and `d1Variants` will only vary the LAST PATH
 *    SEGMENT when that segment is all digits. An endpoint that ends in anything else
 *    is unprobeable, and `classify` correctly refuses to call it LIVE — it returns
 *    DEGRADED with rule `D1-inapplicable`. So the endpoint must end in the agent id.
 *
 *  - D8 needs the on-chain id echoed in `registrations[]` and again at
 *    `/.well-known/agent-registration.json` on the same host.
 *
 * Encoding both here means a new reference agent cannot be added in a shape that
 * AiKi's own prober would have to mark down.
 */

import { BSC_MAINNET } from '../config/chains.js'
import { REGISTRATION_TYPE } from '../prober/registration.js'

export interface ReferenceRegistrationConfig {
  /** Public HTTPS origin this process is reachable at. */
  publicBaseUrl: string
  /** The ERC-8004 token id minted for this agent. Numeric, never a placeholder. */
  agentId: string
}

export interface ReferenceManifestSpec {
  name: string
  description: string
  /** Path of the capability endpoint, WITHOUT the trailing agent id. */
  servicePath: string
  serviceName: string
  iconPath: string
  version?: string
}

/**
 * What one assessment costs, in USDT base units (six decimals), so 100000 is
 * $0.10.
 *
 * Every reference agent charges the same, because they do the same amount of
 * work: one read of live chain state and one verdict. A published price is what
 * makes an agent quotable, and until these carried one, `/v1/quotes` refused
 * every hire on the marketplace including AiKi's own.
 */
export const REFERENCE_PRICE = { amount: '100000', asset: 'USDT' } as const

export const REFERENCE_REGISTRY = `eip155:${BSC_MAINNET.id}:${BSC_MAINNET.contracts.erc8004Identity}`

/** Returns the normalised base URL, or null if it is not a usable public identity. */
export function referenceBase(config: ReferenceRegistrationConfig | undefined): string | null {
  if (!config) return null
  if (!/^\d+$/.test(config.agentId)) return null
  let url: URL
  try {
    url = new URL(config.publicBaseUrl)
  } catch {
    return null
  }
  // An agent registered under http:// is a downgrade attack waiting to happen, and
  // the prober's own fetch guard refuses it, so it could never grade LIVE anyway.
  if (url.protocol !== 'https:') return null
  return url.toString().replace(/\/$/, '')
}

export function referenceEndpoint(base: string, spec: ReferenceManifestSpec, agentId: string) {
  return `${base}${spec.servicePath}/${agentId}`
}

export function referenceManifest(
  config: ReferenceRegistrationConfig,
  spec: ReferenceManifestSpec,
) {
  const base = referenceBase(config)
  if (!base)
    throw new Error(
      'A reference registration needs an HTTPS base URL and a numeric ERC-8004 token id.',
    )
  return {
    type: REGISTRATION_TYPE,
    name: spec.name,
    description: spec.description,
    image: `${base}${spec.iconPath}`,
    active: true,
    services: [
      {
        name: spec.serviceName,
        endpoint: referenceEndpoint(base, spec, config.agentId),
        version: spec.version ?? '1.0.0',
      },
    ],
    registrations: [{ agentId: config.agentId, agentRegistry: REFERENCE_REGISTRY }],
    supportedTrust: [],
    pricing: { ...REFERENCE_PRICE },
  }
}

/** The file-at-domain half of D8. Same shape whether one agent is hosted here or four. */
export function reciprocalProof(agentIds: string[]) {
  return {
    registrations: agentIds.map((agentId) => ({ agentId, agentRegistry: REFERENCE_REGISTRY })),
  }
}

export const NOT_REGISTERED = {
  error: {
    code: 'REFERENCE_NOT_REGISTERED',
    message:
      'This reference service is callable, but its public HTTPS URL and ERC-8004 token id have not been configured.',
  },
} as const
