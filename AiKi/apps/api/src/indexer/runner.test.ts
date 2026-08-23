import { describe, expect, it } from 'vitest'
import { InMemoryEvidenceStore } from '../evidence/store.js'
import type { RegisteredEvent } from './registry.js'
import { runRegistryIndexer } from './runner.js'

const event = (blockNumber: number, logIndex = 0): RegisteredEvent => ({ agentId: String(blockNumber), owner: '0x0000000000000000000000000000000000000001', agentURI: 'https://example.test/agent.json', blockNumber, logIndex, txHash: `0x${blockNumber.toString(16).padStart(64, '0')}` })
describe('runRegistryIndexer', () => {
  it('persists finalized observations and resumes from its checkpoint', async () => {
    const store = new InMemoryEvidenceStore()
    const source = {
      finalizedBlockNumber: async () => 102,
      blockTimestamp: async (block: number) => `2026-08-20T10:00:${String(block - 100).padStart(2, '0')}.000Z`,
      async *registered(from: number) { if (from <= 101) yield [event(101), event(102)] },
    }
    const first = await runRegistryIndexer(source, store, { initialBlock: 100, now: () => '2026-08-20T11:00:00.000Z' })
    expect(first).toMatchObject({ fromBlock: 100, eventsSeen: 2, observationsInserted: 2 })
    expect((await store.getCheckpoint('bsc:56:erc8004:registered'))?.lastIndexedBlock).toBe(102)
    const second = await runRegistryIndexer(source, store, { initialBlock: 100 })
    expect(second).toMatchObject({ fromBlock: 103, eventsSeen: 0, observationsInserted: 0 })
    expect(store.observations).toHaveLength(2)
  })
})
