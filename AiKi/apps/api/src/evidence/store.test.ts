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

it('reads a block number back as a number, not the string BIGINT returns', async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  const { PostgresEvidenceStore } = await import('./postgres-store.js')
  const store = new PostgresEvidenceStore(url)
  try {
    const block = 118_463_582
    await store.append({
      subject: { type: 'agent', chainId: 56, registry: '0xbig', agentId: 'bigint-check' },
      predicate: 'erc8004.agent_registered',
      value: { owner: '0x1', agentURI: 'https://x' },
      validAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:00.000Z',
      source: 'test',
      method: 'test',
      evidenceClass: 'A',
      blockNumber: block,
      dedupeKey: 'bigint-check',
    })
    const row = (await store.list()).find((o) => o.subject.agentId === 'bigint-check')
    // Every projection tests typeof === 'number'. A string here means a real
    // block reads as no block, which is how lastIndexedBlock stayed 0 in
    // production while the indexer was working.
    expect(typeof row?.blockNumber).toBe('number')
    expect(row?.blockNumber).toBe(block)
  } finally {
    await store.close()
  }
})

it('resumes from a number, so the next block is addition and not concatenation', async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  const { PostgresEvidenceStore } = await import('./postgres-store.js')
  const store = new PostgresEvidenceStore(url)
  try {
    const stream = `checkpoint-type-${Date.now()}`
    await store.saveCheckpoint({
      stream,
      lastIndexedBlock: 118_464_140,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const back = await store.getCheckpoint(stream)
    expect(typeof back?.lastIndexedBlock).toBe('number')
    // The bug this exists for: a string checkpoint made the next block
    // 1184641401, past the chain head, so the indexer did nothing and said it
    // had succeeded.
    expect((back?.lastIndexedBlock ?? 0) + 1).toBe(118_464_141)
  } finally {
    await store.close()
  }
})
