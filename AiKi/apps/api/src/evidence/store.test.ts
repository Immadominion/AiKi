import { describe, expect, it } from 'vitest'
import { InMemoryEvidenceStore, materializeObservation } from './store.js'

const input = {
  subject: {
    type: 'agent' as const,
    chainId: 56,
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    agentId: '1',
  },
  predicate: 'erc8004.agent_registered',
  value: { owner: '0xabc' },
  validAt: '2026-08-20T10:00:00.000Z',
  observedAt: '2026-08-20T10:00:01.000Z',
  source: 'chain:bsc',
  method: 'erc8004:Registered/v1',
  evidenceClass: 'A' as const,
  finality: 'finalized' as const,
  dedupeKey: 'chain:56:tx:0',
}
describe('evidence store', () => {
  it('is idempotent by source-derived dedupe key', async () => {
    const store = new InMemoryEvidenceStore()
    expect((await store.append(input)).inserted).toBe(true)
    expect((await store.append(input)).inserted).toBe(false)
    expect(store.observations).toHaveLength(1)
  })
  it('rejects facts recorded before they were observed', () => {
    expect(() =>
      materializeObservation({ ...input, recordedAt: '2026-08-20T09:59:59.000Z' }),
    ).toThrow('recordedAt cannot precede observedAt')
  })
})
