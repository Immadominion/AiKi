import { describe, expect, it } from 'vitest'
import { InMemoryEvidenceStore } from '../evidence/store.js'
import { persistVerification } from './evidence-sink.js'

describe('persistVerification', () => {
  it('preserves raw samples, verdict, reciprocal proof, and readiness as separate observations', async () => {
    const store = new InMemoryEvidenceStore()
    const result = await persistVerification(store, {
      chainId: 56,
      registry: '0x8004',
      agentId: '7',
      identityVerified: true,
      registration: {
        uri: 'data:application/json,{}',
        scheme: 'data',
        status: 'resolved',
        fetchedAt: '2026-08-20T10:00:00.000Z',
        zeroCost: true,
        manifest: {
          type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
          name: 'Agent',
          description: 'Desc',
          image: 'https://agent.example/icon.png',
          services: [],
          registrations: [],
          supportedTrust: [],
        },
      },
      probe: {
        agentId: '7',
        probedAt: '2026-08-20T10:01:00.000Z',
        registrationWasZeroCost: true,
        reciprocal: { verified: false, detail: 'Missing.' },
        verdict: { state: 'IMPOSTOR_STATIC', rule: 'D1', detail: 'Static.' },
        samples: [
          {
            label: 'valid',
            url: 'https://agent.example?id=7',
            status: 200,
            bodyHash: 'same',
            bodyLength: 2,
            contentType: 'application/json',
            latencyMs: 12,
          },
          {
            label: 'nonsense',
            url: 'https://agent.example?id=999',
            status: 200,
            bodyHash: 'same',
            bodyLength: 2,
            contentType: 'application/json',
            latencyMs: 11,
          },
        ],
      },
    })
    expect(result.observationsInserted).toBe(6)
    expect(result.readiness.status).toBe('not_ready')
    expect(store.observations.map((item) => item.predicate)).toEqual(
      expect.arrayContaining([
        'erc8004.registration_resolution',
        'agent.liveness_verdict',
        'erc8004.reciprocal_proof',
        'marketplace.readiness',
        'agent.capability_probe',
      ]),
    )
  })
})
