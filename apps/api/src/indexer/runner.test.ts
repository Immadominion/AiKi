import { describe, expect, it } from 'vitest'
import { InMemoryEvidenceStore } from '../evidence/store.js'
import { REGISTRY_STREAM } from './evidence-sink.js'
import type { RegisteredEvent } from './registry.js'
import { type RegistrySource, runRegistryIndexer } from './runner.js'

const event = (blockNumber: number, logIndex = 0): RegisteredEvent => ({
  agentId: String(blockNumber),
  owner: '0x0000000000000000000000000000000000000001',
  agentURI: 'https://example.test/agent.json',
  blockNumber,
  logIndex,
  txHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
})
describe('runRegistryIndexer', () => {
  it('persists finalized observations and resumes from its checkpoint', async () => {
    const store = new InMemoryEvidenceStore()
    const source = {
      finalizedBlockNumber: async () => 102,
      blockTimestamp: async (block: number) =>
        `2026-08-20T10:00:${String(block - 100).padStart(2, '0')}.000Z`,
      async *registered(from: number) {
        if (from <= 101) yield [event(101), event(102)]
      },
    }
    const first = await runRegistryIndexer(source, store, {
      initialBlock: 100,
      now: () => '2026-08-20T11:00:00.000Z',
    })
    expect(first).toMatchObject({ fromBlock: 100, eventsSeen: 2, observationsInserted: 2 })
    expect((await store.getCheckpoint('bsc:56:erc8004:registered'))?.lastIndexedBlock).toBe(102)
    const second = await runRegistryIndexer(source, store, { initialBlock: 100 })
    expect(second).toMatchObject({ fromBlock: 103, eventsSeen: 0, observationsInserted: 0 })
    expect(store.observations).toHaveLength(2)
  })
})

it('advances the checkpoint through a range with no registrations in it', async () => {
  const store = new InMemoryEvidenceStore()
  const source: RegistrySource = {
    finalizedBlockNumber: async () => 1_000,
    blockTimestamp: async () => '2026-01-01T00:00:00.000Z',
    // eslint-disable-next-line require-yield
    async *registered() {
      // Nothing registered in this stretch of chain.
    },
  }

  await runRegistryIndexer(source, store, { initialBlock: 100 })

  // Without this the checkpoint never moved on a quiet range, so every run
  // rescanned the same ever-growing window until the provider refused.
  expect((await store.getCheckpoint(REGISTRY_STREAM))?.lastIndexedBlock).toBe(1_000)
})

it('covers at most maxBlocksPerRun, so a large gap is crossed in steps', async () => {
  const store = new InMemoryEvidenceStore()
  const source: RegistrySource = {
    finalizedBlockNumber: async () => 500_000,
    blockTimestamp: async () => '2026-01-01T00:00:00.000Z',
    async *registered() {},
  }

  await runRegistryIndexer(source, store, { initialBlock: 100, maxBlocksPerRun: 5_000 })
  expect((await store.getCheckpoint(REGISTRY_STREAM))?.lastIndexedBlock).toBe(5_099)

  await runRegistryIndexer(source, store, { initialBlock: 100, maxBlocksPerRun: 5_000 })
  expect((await store.getCheckpoint(REGISTRY_STREAM))?.lastIndexedBlock).toBe(10_099)
})

it('records where scanning began, follows a rewind down, and never raises it', async () => {
  const store = new InMemoryEvidenceStore()
  const source: RegistrySource = {
    finalizedBlockNumber: async () => 5_000,
    blockTimestamp: async () => '2026-08-29T00:00:00.000Z',
    async *registered() {
      // Deliberately empty: coverage is a claim about the range scanned, not
      // about the events found in it.
    },
  }
  const coverage = async () =>
    (await store.getCheckpoint('bsc:56:erc8004:coverage-start'))?.lastIndexedBlock

  const first = await runRegistryIndexer(source, store, { initialBlock: 1_000 })
  expect(first.coverageStart).toBe(1_000)
  expect(await coverage()).toBe(1_000)

  // Ordinary forward progress resumes at 5,001 and must not move the start.
  const second = await runRegistryIndexer(source, store, { initialBlock: 1_000 })
  expect(second.coverageStart).toBe(1_000)
  expect(await coverage()).toBe(1_000)

  // A rewind moves the resume point back; coverage follows it down.
  await store.saveCheckpoint({
    stream: REGISTRY_STREAM,
    lastIndexedBlock: 99,
    updatedAt: '2026-08-29T00:00:00.000Z',
  })
  const third = await runRegistryIndexer(source, store, { initialBlock: 1_000 })
  expect(third.coverageStart).toBe(100)
  expect(await coverage()).toBe(100)
})
