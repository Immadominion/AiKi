import { BSC_MAINNET } from '../config/chains.js'
import type { EvidenceStore, NewObservation } from '../evidence/types.js'
import type { RegisteredEvent } from './registry.js'

export const REGISTRY_STREAM = 'bsc:56:erc8004:registered'

/**
 * The lowest block this deployment has ever begun a scan at.
 *
 * The registration checkpoint says where scanning got to; nothing said where it
 * started, so "have we seen the whole registry" had to be inferred from the
 * earliest event we happened to hold — a number that can never reach the
 * registry's first block, because the first block predates the first event.
 */
export const COVERAGE_START_STREAM = 'bsc:56:erc8004:coverage-start'

/** Convert one finalized log into a provenance-complete, immutable fact. */
export function registeredObservation(event: RegisteredEvent, validAt: string): NewObservation {
  return {
    subject: {
      type: 'agent',
      chainId: BSC_MAINNET.id,
      registry: BSC_MAINNET.contracts.erc8004Identity,
      agentId: event.agentId,
    },
    predicate: 'erc8004.agent_registered',
    value: { owner: event.owner, agentURI: event.agentURI },
    validAt,
    observedAt: new Date().toISOString(),
    source: 'chain:bsc',
    method: 'erc8004:Registered/v1',
    evidenceClass: 'A',
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    transactionHash: event.txHash,
    finality: 'finalized',
    dedupeKey: `bsc:56:registered:${event.txHash.toLowerCase()}:${event.logIndex}`,
  }
}

export async function persistRegisteredBatch(
  store: EvidenceStore,
  events: RegisteredEvent[],
  blockTimestamp: (blockNumber: number) => Promise<string>,
): Promise<number> {
  let inserted = 0
  const timestamps = new Map<number, string>()
  for (const event of events) {
    let validAt = timestamps.get(event.blockNumber)
    if (!validAt) {
      validAt = await blockTimestamp(event.blockNumber)
      timestamps.set(event.blockNumber, validAt)
    }
    if ((await store.append(registeredObservation(event, validAt))).inserted) inserted += 1
  }
  return inserted
}
