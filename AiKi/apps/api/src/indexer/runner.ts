import type { EvidenceStore } from '../evidence/types.js'
import { persistRegisteredBatch, REGISTRY_STREAM } from './evidence-sink.js'
import type { RegisteredEvent } from './registry.js'

export interface RegistrySource {
  finalizedBlockNumber(): Promise<number>
  blockTimestamp(blockNumber: number): Promise<string>
  registered(fromBlock: number): AsyncGenerator<RegisteredEvent[]>
}
export interface RunRegistryIndexerOptions {
  initialBlock: number
  /**
   * Most blocks one run will cover. Catching up across a large gap in a single
   * pass means thousands of eth_getLogs calls, which every free endpoint
   * refuses; a bounded run makes progress and comes back.
   */
  maxBlocksPerRun?: number
  now?: () => string
}
export interface RegistryRunResult {
  fromBlock: number
  finalizedHead: number
  eventsSeen: number
  observationsInserted: number
}

/** Checkpoints advance only after every fact in a batch is accepted; reruns are idempotent. */
export async function runRegistryIndexer(
  source: RegistrySource,
  store: EvidenceStore,
  options: RunRegistryIndexerOptions,
): Promise<RegistryRunResult> {
  const checkpoint = await store.getCheckpoint(REGISTRY_STREAM)
  const fromBlock = checkpoint ? checkpoint.lastIndexedBlock + 1 : options.initialBlock
  const finalizedHead = await source.finalizedBlockNumber()
  if (fromBlock > finalizedHead)
    return { fromBlock, finalizedHead, eventsSeen: 0, observationsInserted: 0 }
  const ceiling = options.maxBlocksPerRun
    ? Math.min(finalizedHead, fromBlock + options.maxBlocksPerRun - 1)
    : finalizedHead
  let eventsSeen = 0
  let observationsInserted = 0
  let scannedTo = fromBlock - 1
  for await (const batch of source.registered(fromBlock)) {
    if (batch.length === 0) continue
    eventsSeen += batch.length
    observationsInserted += await persistRegisteredBatch(store, batch, source.blockTimestamp)
    const last = batch.at(-1)
    if (last) {
      scannedTo = Math.max(scannedTo, last.blockNumber)
      await store.saveCheckpoint({
        stream: REGISTRY_STREAM,
        lastIndexedBlock: last.blockNumber,
        updatedAt: (options.now ?? (() => new Date().toISOString()))(),
      })
    }
    if (scannedTo >= ceiling) break
  }

  /**
   * A range with no registrations in it has still been examined, and the
   * checkpoint has to say so. It used to advance only when a batch arrived, so
   * a quiet stretch of chain meant rescanning the same, ever-growing window
   * every five minutes until the provider refused. Absence of events is
   * progress, and recording it is what makes the indexer resumable rather than
   * merely restartable.
   */
  if (ceiling > scannedTo)
    await store.saveCheckpoint({
      stream: REGISTRY_STREAM,
      lastIndexedBlock: ceiling,
      updatedAt: (options.now ?? (() => new Date().toISOString()))(),
    })
  return { fromBlock, finalizedHead, eventsSeen, observationsInserted }
}
