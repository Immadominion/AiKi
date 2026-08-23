import { describe, expect, it } from 'vitest'
import type { ProbeAgentResult } from './probe.js'
import { marketplaceReadiness } from './readiness.js'
import type { RegistrationResolution } from './registration.js'

const registration: RegistrationResolution = {
  uri: 'https://agent.example/registration.json',
  scheme: 'https',
  status: 'resolved',
  fetchedAt: '2026-08-20T10:00:00.000Z',
  zeroCost: false,
  manifest: {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Agent',
    description: 'Desc',
    image: 'https://agent.example/icon.png',
    services: [],
    registrations: [],
    supportedTrust: [],
  },
}
const probe: ProbeAgentResult = {
  agentId: '1',
  probedAt: '2026-08-20T10:01:00.000Z',
  registrationWasZeroCost: false,
  samples: [],
  reciprocal: { verified: true, detail: 'Verified.' },
  verdict: { state: 'LIVE', rule: 'D5', detail: 'Callable.' },
}

describe('marketplaceReadiness', () => {
  it('does not claim permissions are inspectable before Phase 5', () => {
    const readiness = marketplaceReadiness({ identityVerified: true, registration, probe })
    expect(readiness.status).toBe('ready')
    expect(
      readiness.badges.find((badge) => badge.code === 'permissions_inspectable'),
    ).toMatchObject({ verified: false })
  })
  it('rejects a static impostor from marketplace readiness', () => {
    const readiness = marketplaceReadiness({
      identityVerified: true,
      registration,
      probe: { ...probe, verdict: { state: 'IMPOSTOR_STATIC', rule: 'D1', detail: 'Static.' } },
    })
    expect(readiness.status).toBe('not_ready')
  })
})
