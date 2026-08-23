import { BSC_MAINNET } from '../../config/chains.js'
import { REGISTRATION_TYPE } from '../../prober/registration.js'

export interface VenusRegistrationConfig {
  publicBaseUrl: string
  agentId: string
}

function baseUrl(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'https:')
    throw new Error(
      'REFERENCE_AGENT_BASE_URL must use HTTPS before this agent is registered onchain.',
    )
  return url.toString().replace(/\/$/, '')
}

/** ERC-8004 registration-v1 generated from deployment config; never hard-code a future token id. */
export function venusRegistration(config: VenusRegistrationConfig) {
  if (!/^\d+$/.test(config.agentId))
    throw new Error('VENUS_GUARDIAN_AGENT_ID must be an ERC-8004 numeric token id.')
  const base = baseUrl(config.publicBaseUrl)
  return {
    type: REGISTRATION_TYPE,
    name: 'AiKi Venus Health Factor Guardian',
    description:
      'First-party reference agent that reads Venus lending positions, derives a health factor, and reports evidence-backed liquidation risk. It is read-only until a separate constrained authority grant exists.',
    image: `${base}/v1/reference/venus/icon.svg`,
    active: true,
    services: [
      {
        name: 'venus-health-factor-assessment',
        endpoint: `${base}/v1/reference/venus/agent/${config.agentId}`,
        version: '1.0.0',
      },
    ],
    registrations: [
      {
        agentId: config.agentId,
        agentRegistry: `eip155:${BSC_MAINNET.id}:${BSC_MAINNET.contracts.erc8004Identity}`,
      },
    ],
    supportedTrust: [],
  }
}

export function venusReciprocalProof(agentId: string) {
  return {
    registrations: [
      {
        agentId,
        agentRegistry: `eip155:${BSC_MAINNET.id}:${BSC_MAINNET.contracts.erc8004Identity}`,
      },
    ],
  }
}
