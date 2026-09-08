import type { LivenessState } from '@aiki/contracts'
import type { ProbeAgentResult } from './probe.js'
import type { RegistrationResolution } from './registration.js'

export type ReadinessStatus = 'ready' | 'limited_evidence' | 'not_ready'
export interface ReadinessBadge {
  code: string
  verified: boolean
  detail: string
}
export interface MarketplaceReadiness {
  status: ReadinessStatus
  badges: ReadinessBadge[]
  reasons: string[]
}

/** A projection: no score, no hidden weights, only inspectable eligibility facts. */
export function marketplaceReadiness(input: {
  identityVerified: boolean
  registration: RegistrationResolution
  probe: ProbeAgentResult
}): MarketplaceReadiness {
  const live = input.probe.verdict.state === 'LIVE'
  const registrationResolved = input.registration.status === 'resolved'
  const reciprocal = input.probe.reciprocal?.verified === true
  const inspectablePermissions = false // Authority integration is Phase 5; do not manufacture this badge.
  const badges: ReadinessBadge[] = [
    {
      code: 'identity_verified',
      verified: input.identityVerified,
      detail: input.identityVerified
        ? 'Canonical ERC-8004 identity was indexed from BSC.'
        : 'No canonical identity evidence.',
    },
    {
      code: 'registration_resolved',
      verified: registrationResolved,
      detail: input.registration.detail ?? 'Registration-v1 resolved from the onchain URI.',
    },
    { code: 'activity_verified', verified: live, detail: input.probe.verdict.detail },
    {
      code: 'reciprocal_proof',
      verified: reciprocal,
      detail: input.probe.reciprocal?.detail ?? 'No reciprocal proof was evaluated.',
    },
    {
      code: 'permissions_inspectable',
      verified: inspectablePermissions,
      detail: 'Not yet available; authority integration is not implemented.',
    },
  ]
  const reasons = badges.filter((badge) => !badge.verified).map((badge) => badge.detail)
  const status: ReadinessStatus =
    input.identityVerified && registrationResolved && live
      ? reciprocal
        ? 'ready'
        : 'limited_evidence'
      : 'not_ready'
  return { status, badges, reasons }
}

export function isTerminallyUnavailable(state: LivenessState): boolean {
  return (
    state === 'IMPOSTOR_STATIC' ||
    state === 'PLACEHOLDER_URL' ||
    state === 'NOT_REMOTE' ||
    state === 'DECLARED_ONLY'
  )
}
