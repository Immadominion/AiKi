import type { EcosystemStats } from '@aiki/contracts'
import { BSC_MAINNET } from '../config/chains.js'
import type { Observation } from '../evidence/types.js'
import { asLiveness } from './passport.js'

const subjectKey = (o: Observation) =>
  `${o.subject.chainId}:${o.subject.registry.toLowerCase()}:${o.subject.agentId}`

/**
 * The honesty dashboard, projected purely from stored observations.
 *
 * `indexed` derives only from chain-indexer evidence and is null when none
 * exists — probe activity must never make a stalled indexer look fresh.
 * `probed.byState` counts each agent once, by its LATEST verdict. `reputation`
 * is null until feedback is actually ingested, because zeros would claim a
 * measurement that never ran.
 */
export interface StatsInput {
  /**
   * Lowest block the indexer has ever begun a scan at, from the coverage-start
   * checkpoint. Undefined means nothing has recorded it, which is not the same as
   * zero and must never read as full coverage.
   */
  coverageStart?: number
}

export function projectStats(observations: Observation[], input: StatsInput = {}): EcosystemStats {
  const { coverageStart } = input
  const latestVerdict = new Map<string, Observation>()
  for (const o of observations) {
    if (o.predicate !== 'agent.liveness_verdict') continue
    const key = subjectKey(o)
    const held = latestVerdict.get(key)
    if (!held || o.observedAt > held.observedAt) latestVerdict.set(key, o)
  }
  const byState: Partial<Record<string, number>> = {}
  let lastProbeSweepAt: string | null = null
  for (const o of latestVerdict.values()) {
    const state = asLiveness(o.value.state)
    byState[state] = (byState[state] ?? 0) + 1
    if (!lastProbeSweepAt || o.observedAt > lastProbeSweepAt) lastProbeSweepAt = o.observedAt
  }

  const indexedRows = observations.filter((o) => o.predicate === 'erc8004.agent_registered')
  const indexedAgents = new Set(indexedRows.map(subjectKey))
  const indexedBsc = new Set(indexedRows.filter((o) => o.subject.chainId === 56).map(subjectKey))
  let lastIndexedBlock = 0
  let firstIndexedBlock = Number.POSITIVE_INFINITY
  let lastIndexedAt: string | null = null
  for (const o of indexedRows) {
    if (typeof o.blockNumber === 'number') {
      if (o.blockNumber > lastIndexedBlock) lastIndexedBlock = o.blockNumber
      if (o.blockNumber < firstIndexedBlock) firstIndexedBlock = o.blockNumber
    }
    if (!lastIndexedAt || o.observedAt > lastIndexedAt) lastIndexedAt = o.observedAt
  }

  return {
    indexed:
      indexedRows.length && lastIndexedAt
        ? {
            totalAgents: indexedAgents.size,
            bscAgents: indexedBsc.size,
            firstIndexedBlock: Number.isFinite(firstIndexedBlock) ? firstIndexedBlock : 0,
            lastIndexedBlock,
            lastIndexedAt,
            // Indexing that began after the registry's first block has seen only
            // part of it, and totalAgents is then a count of what we have seen
            // rather than of what exists.
            //
            // This asks where scanning STARTED, not where the earliest event we
            // hold sits. Those are different questions and only the first one can
            // ever be answered yes: the registry's first block is by definition
            // earlier than its first registration, so comparing the earliest event
            // against it left `complete` permanently, silently false.
            complete:
              typeof coverageStart === 'number' &&
              coverageStart <= BSC_MAINNET.registryGenesisBlock,
          }
        : null,
    probed: {
      agentsProbed: latestVerdict.size,
      byState: byState as EcosystemStats['probed']['byState'],
      lastProbeSweepAt,
    },
    reputation: null,
    categories: {},
  }
}
