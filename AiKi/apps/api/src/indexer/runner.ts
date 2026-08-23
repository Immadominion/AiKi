import type { EvidenceStore } from '../evidence/types.js'
import { persistRegisteredBatch, REGISTRY_STREAM } from './evidence-sink.js'
import type { RegisteredEvent } from './registry.js'

export interface RegistrySource {
  finalizedBlockNumber(): Promise<number>
  blockTimestamp(blockNumber: number): Promise<string>
  registered(fromBlock: number): AsyncGenerator<RegisteredEvent[]>
}
export interface RunRegistryIndexerOptions { initialBlock: number; now?: () => string }
export interface RegistryRunResult { fromBlock: number; finalizedHead: number; eventsSeen: number; observationsInserted: number }

/** Checkpoints advance only after every fact in a batch is accepted; reruns are idempotent. */
export async function runRegistryIndexer(source: RegistrySource, store: EvidenceStore, options: RunRegistryIndexerOptions): Promise<RegistryRunResult> {
  const checkpoint = await store.getCheckpoint(REGISTRY_STREAM)
  const fromBlock = checkpoint ? checkpoint.lastIndexedBlock + 1 : options.initialBlock
  const finalizedHead = await source.finalizedBlockNumber()
  if (fromBlock > finalizedHead) return { fromBlock, finalizedHead, eventsSeen: 0, observationsInserted: 0 }
  let eventsSeen = 0
  let observationsInserted = 0
  for await (const batch of source.registered(fromBlock)) {
    if (batch.length === 0) continue
    eventsSeen += batch.length
    observationsInserted += await persistRegisteredBatch(store, batch, source.blockTimestamp)
    const last = batch.at(-1)
    if (last) await store.saveCheckpoint({ stream: REGISTRY_STREAM, lastIndexedBlock: last.blockNumber, updatedAt: (options.now ?? (() => new Date().toISOString()))() })
  }
  return { fromBlock, finalizedHead, eventsSeen, observationsInserted }
}
