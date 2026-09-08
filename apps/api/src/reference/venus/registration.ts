import {
  type ReferenceRegistrationConfig,
  reciprocalProof,
  referenceBase,
  referenceManifest,
} from '../manifest.js'

export type VenusRegistrationConfig = ReferenceRegistrationConfig

export const VENUS_SPEC = {
  name: 'AiKi Venus Health Factor Guardian',
  description:
    'First-party reference agent that reads Venus lending positions, derives a health factor, and reports evidence-backed liquidation risk. It is read-only until a separate constrained authority grant exists.',
  servicePath: '/v1/reference/venus/agent',
  serviceName: 'venus-health-factor-assessment',
  iconPath: '/v1/reference/venus/icon.svg',
}

/** ERC-8004 registration-v1 generated from deployment config; never hard-code a future token id. */
export function venusRegistration(config: VenusRegistrationConfig) {
  if (!/^\d+$/.test(config.agentId))
    throw new Error('VENUS_GUARDIAN_AGENT_ID must be an ERC-8004 numeric token id.')
  if (!referenceBase(config))
    throw new Error(
      'REFERENCE_AGENT_BASE_URL must be an HTTPS origin before this agent is registered onchain.',
    )
  return referenceManifest(config, VENUS_SPEC)
}

export function venusReciprocalProof(agentId: string) {
  return reciprocalProof([agentId])
}
