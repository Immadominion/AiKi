import type { EcosystemStats } from '@aiki/contracts'
import { BSC_MAINNET } from '../config/chains.js'
import type { Observation } from '../evidence/types.js'
import { classifyDeclared, declaredText } from './categories.js'
import { asLiveness } from './passport.js'

const subjectKey = (o: Observation) =>
  `${o.subject.chainId}:${o.subject.registry.toLowerCase()}:${o.subject.agentId}`

export interface StatsInput {
  /**
   * Lowest block the indexer has ever begun a scan at, from the coverage-start
   * checkpoint. Undefined means nothing has recorded it, which is not the same as
   * zero and must never read as full coverage.
   */
  coverageStart?: number
}

/**
 * The only numbers the dashboard needs, and the only ones it is allowed to use.
 *
 * This exists so the figures can be counted where the rows are. They used to be
 * folded in memory from `store.list()`, which is `ORDER BY observed_at DESC LIMIT
 * 10000` — so once the store held more than ten thousand observations the
 * dashboard was computed from a moving window of the most recent ones. Every new
 * registration pushed an older probe verdict out of that window, and the
 * published totals went DOWN as the system learned more: 1,392 agents probed
 * became 920, nine live became four, with nothing anywhere saying a limit had
 * been reached.
 *
 * A silently truncated count is the one failure this product cannot have. Two
 * implementations produce this shape — one over an array, one in SQL — and a test
 * runs the same evidence through both and requires identical output, because the
 * risk in having two is that they drift.
 */
export interface StatsAggregate {
  indexed: {
    /** Distinct agents carrying registration evidence. */
    totalAgents: number
    bscAgents: number
    /** Null when no registration row carries a block number. */
    firstIndexedBlock: number | null
    lastIndexedBlock: number | null
    lastIndexedAt: string | null
  }
  probed: {
    agentsProbed: number
    /** Counted by the raw stored state; `asLiveness` is applied once, below. */
    byRawState: Record<string, number>
    lastProbeSweepAt: string | null
  }
  /**
   * Agents grouped by what their OWN registration says they do.
   *
   * Only agents that resolved a manifest are counted, because an agent that
   * declared nothing has not failed to match a rule, it has said nothing to
   * match. Filing it under `other` would report a declaration that does not
   * exist, so the totals here are deliberately smaller than `indexed`.
   */
  categories: Record<string, { agents: number; live: number }>
}

/** Fold an aggregate into the published shape. The one place the rules live. */
export function assembleStats(agg: StatsAggregate, input: StatsInput = {}): EcosystemStats {
  const byState: Partial<Record<string, number>> = {}
  for (const [raw, n] of Object.entries(agg.probed.byRawState)) {
    // Two raw values can normalise to one state, so accumulate rather than assign.
    const state = asLiveness(raw)
    byState[state] = (byState[state] ?? 0) + n
  }

  return {
    indexed:
      agg.indexed.totalAgents && agg.indexed.lastIndexedAt
        ? {
            totalAgents: agg.indexed.totalAgents,
            bscAgents: agg.indexed.bscAgents,
            firstIndexedBlock: agg.indexed.firstIndexedBlock ?? 0,
            lastIndexedBlock: agg.indexed.lastIndexedBlock ?? 0,
            lastIndexedAt: agg.indexed.lastIndexedAt,
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
              typeof input.coverageStart === 'number' &&
              input.coverageStart <= BSC_MAINNET.registryGenesisBlock,
          }
        : null,
    probed: {
      agentsProbed: agg.probed.agentsProbed,
      byState: byState as EcosystemStats['probed']['byState'],
      lastProbeSweepAt: agg.probed.lastProbeSweepAt,
    },
    reputation: null,
    categories: agg.categories,
  }
}

/** Count from an array. Correct for any store small enough to hold in memory. */
export function aggregateStats(observations: Observation[]): StatsAggregate {
  const latestVerdict = new Map<string, Observation>()
  for (const o of observations) {
    if (o.predicate !== 'agent.liveness_verdict') continue
    const key = subjectKey(o)
    const held = latestVerdict.get(key)
    if (!held || o.observedAt > held.observedAt) latestVerdict.set(key, o)
  }
  const byRawState: Record<string, number> = {}
  let lastProbeSweepAt: string | null = null
  for (const o of latestVerdict.values()) {
    const raw = String(o.value.state)
    byRawState[raw] = (byRawState[raw] ?? 0) + 1
    if (!lastProbeSweepAt || o.observedAt > lastProbeSweepAt) lastProbeSweepAt = o.observedAt
  }

  const indexedRows = observations.filter((o) => o.predicate === 'erc8004.agent_registered')
  const indexedAgents = new Set(indexedRows.map(subjectKey))
  const indexedBsc = new Set(indexedRows.filter((o) => o.subject.chainId === 56).map(subjectKey))
  let lastIndexedBlock: number | null = null
  let firstIndexedBlock: number | null = null
  let lastIndexedAt: string | null = null
  for (const o of indexedRows) {
    if (typeof o.blockNumber === 'number') {
      if (lastIndexedBlock === null || o.blockNumber > lastIndexedBlock)
        lastIndexedBlock = o.blockNumber
      if (firstIndexedBlock === null || o.blockNumber < firstIndexedBlock)
        firstIndexedBlock = o.blockNumber
    }
    if (!lastIndexedAt || o.observedAt > lastIndexedAt) lastIndexedAt = o.observedAt
  }

  const latestManifest = new Map<string, Observation>()
  for (const o of observations) {
    if (o.predicate !== 'erc8004.registration_resolution') continue
    const key = subjectKey(o)
    const held = latestManifest.get(key)
    if (!held || o.observedAt > held.observedAt) latestManifest.set(key, o)
  }
  const categories: Record<string, { agents: number; live: number }> = {}
  for (const [key, o] of latestManifest) {
    const manifest = o.value.manifest
    if (!manifest || typeof manifest !== 'object') continue
    const category = classifyDeclared(declaredText(manifest as Record<string, unknown>))
    const bucket = categories[category] ?? { agents: 0, live: 0 }
    categories[category] = bucket
    bucket.agents += 1
    if (asLiveness(latestVerdict.get(key)?.value.state) === 'LIVE') bucket.live += 1
  }

  return {
    categories,
    indexed: {
      totalAgents: indexedAgents.size,
      bscAgents: indexedBsc.size,
      firstIndexedBlock,
      lastIndexedBlock,
      lastIndexedAt,
    },
    probed: {
      agentsProbed: latestVerdict.size,
      byRawState,
      lastProbeSweepAt,
    },
  }
}

/**
 * The honesty dashboard, projected purely from stored observations.
 *
 * `indexed` derives only from chain-indexer evidence and is null when none
 * exists — probe activity must never make a stalled indexer look fresh.
 * `probed.byState` counts each agent once, by its LATEST verdict. `reputation`
 * is null until feedback is actually ingested, because zeros would claim a
 * measurement that never ran.
 */
export function projectStats(observations: Observation[], input: StatsInput = {}): EcosystemStats {
  return assembleStats(aggregateStats(observations), input)
}
