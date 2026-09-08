import type { EvidenceStore } from '../evidence/types.js'
import { COVERAGE_START_STREAM, persistRegisteredBatch, REGISTRY_STREAM } from './evidence-sink.js'
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
  /** Lowest block ever scanned by this deployment, after this run. */
  coverageStart: number
}

/** Checkpoints advance only after every fact in a batch is accepted; reruns are idempotent. */
export async function runRegistryIndexer(
  source: RegistrySource,
  store: EvidenceStore,
  options: RunRegistryIndexerOptions,
): Promise<RegistryRunResult> {
  const checkpoint = await store.getCheckpoint(REGISTRY_STREAM)
  const fromBlock = checkpoint ? checkpoint.lastIndexedBlock + 1 : options.initialBlock
  const now = options.now ?? (() => new Date().toISOString())

  /**
   * Record where scanning began, and only ever lower it.
   *
   * A rewind moves the resume point backwards and this follows it down; ordinary
   * forward progress leaves it alone. That makes coverage a claim about a range
   * we actually walked rather than about the oldest thing we happen to hold.
   */
  const recorded = await store.getCheckpoint(COVERAGE_START_STREAM)
  const coverageStart = recorded ? Math.min(recorded.lastIndexedBlock, fromBlock) : fromBlock
  if (!recorded || coverageStart < recorded.lastIndexedBlock)
    await store.saveCheckpoint({
      stream: COVERAGE_START_STREAM,
      lastIndexedBlock: coverageStart,
      updatedAt: now(),
    })

  const finalizedHead = await source.finalizedBlockNumber()
  if (fromBlock > finalizedHead)
    return { fromBlock, finalizedHead, eventsSeen: 0, observationsInserted: 0, coverageStart }
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
        updatedAt: now(),
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
      updatedAt: now(),
    })
  return { fromBlock, finalizedHead, eventsSeen, observationsInserted, coverageStart }
}
