import postgres from 'postgres'
import type { StatsAggregate } from '../projections/stats.js'
import { materializeObservation } from './store.js'
import type { AppendResult, EvidenceStore, IndexerCheckpoint, NewObservation } from './types.js'

/** PostgreSQL-backed evidence store. The migration enforces append-only observations. */
/**
 * The postgres driver hands timestamptz columns back as Date objects; every
 * projection downstream compares observedAt as an ISO string, so timestamps
 * are normalized at the boundary or sorting silently breaks.
 */
const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value)

/**
 * BIGINT arrives as a string.
 *
 * The postgres driver returns int8 as a string to avoid losing precision above
 * 2^53, which is correct of it and quietly wrong for us: every projection tests
 * `typeof blockNumber === 'number'`, so a real block silently read as no block
 * and lastIndexedBlock sat at 0 while the indexer was working perfectly. Block
 * numbers are nowhere near the precision limit, so narrowing them here is safe
 * and is the same boundary fix the timestamps needed.
 */

export class PostgresEvidenceStore implements EvidenceStore {
  private readonly sql: postgres.Sql
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 10, idle_timeout: 20 })
  }
  async append(input: NewObservation): Promise<AppendResult> {
    const observation = materializeObservation(input)
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO observations (id, subject_type, chain_id, registry_address, agent_id, predicate, value, valid_at, observed_at, recorded_at, source, method, evidence_class, block_number, log_index, transaction_hash, finality, supersedes, superseded_reason, dedupe_key)
      VALUES (${observation.id}, ${observation.subject.type}, ${observation.subject.chainId}, ${observation.subject.registry.toLowerCase()}, ${observation.subject.agentId}, ${observation.predicate}, ${this.sql.json(observation.value as unknown as postgres.JSONValue)}, ${observation.validAt}, ${observation.observedAt}, ${observation.recordedAt}, ${observation.source}, ${observation.method}, ${observation.evidenceClass}, ${observation.blockNumber ?? null}, ${observation.logIndex ?? null}, ${observation.transactionHash ?? null}, ${observation.finality ?? null}, ${observation.supersedes ?? null}, ${observation.supersededReason ?? null}, ${observation.dedupeKey})
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
    `
    return { observation, inserted: rows.length === 1 }
  }
  /**
   * The resume point, as a number.
   *
   * `last_indexed_block` is BIGINT and the driver hands it back as a string, so
   * the runner's `lastIndexedBlock + 1` concatenated instead of adding: a
   * checkpoint at 118464140 produced a next block of 1184641401, which is past
   * the chain head, so every subsequent run indexed nothing and exited zero. A
   * stuck indexer reporting success is worse than one that crashes, because
   * nothing ever asks why.
   */
  async getCheckpoint(stream: string): Promise<IndexerCheckpoint | null> {
    const rows = await this.sql<
      { stream: string; lastIndexedBlock: string | number; updatedAt: string | Date }[]
    >`SELECT stream, last_indexed_block AS "lastIndexedBlock", updated_at AS "updatedAt" FROM indexer_checkpoints WHERE stream = ${stream}`
    const row = rows[0]
    if (!row) return null
    return {
      stream: row.stream,
      lastIndexedBlock: Number(row.lastIndexedBlock),
      updatedAt: iso(row.updatedAt),
    }
  }
  async saveCheckpoint(checkpoint: IndexerCheckpoint): Promise<void> {
    await this
      .sql`INSERT INTO indexer_checkpoints (stream, last_indexed_block, updated_at) VALUES (${checkpoint.stream}, ${checkpoint.lastIndexedBlock}, ${checkpoint.updatedAt}) ON CONFLICT (stream) DO UPDATE SET last_indexed_block = EXCLUDED.last_indexed_block, updated_at = EXCLUDED.updated_at`
  }
  /**
   * Agents that should be probed next: never probed first, then stalest.
   *
   * Registration and probing are joined on the full subject, not just the token
   * id, because a token id is only unique within its own registry.
   */
  async dueForProbe(limit: number, staleAfterHours: number) {
    return this.sql<
      {
        chain_id: number
        registry_address: string
        agent_id: string
        agent_uri: string
        last_probed_at: string | Date | null
      }[]
    >`
      WITH registered AS (
        SELECT DISTINCT ON (chain_id, registry_address, agent_id)
          chain_id, registry_address, agent_id, value->>'agentURI' AS agent_uri, block_number
        FROM observations
        WHERE predicate = 'erc8004.agent_registered'
        ORDER BY chain_id, registry_address, agent_id, observed_at DESC
      ),
      probed AS (
        SELECT chain_id, registry_address, agent_id, MAX(observed_at) AS last_probed_at
        FROM observations
        WHERE predicate = 'agent.liveness_verdict'
        GROUP BY chain_id, registry_address, agent_id
      )
      SELECT r.chain_id, r.registry_address, r.agent_id, r.agent_uri, p.last_probed_at
      FROM registered r
      LEFT JOIN probed p
        ON p.chain_id = r.chain_id
       AND p.registry_address = r.registry_address
       AND p.agent_id = r.agent_id
      WHERE r.agent_uri IS NOT NULL
        AND (
          p.last_probed_at IS NULL
          OR p.last_probed_at < now() - ${`${staleAfterHours} hours`}::interval
        )
      /**
       * Never-probed first, and among those the most recently REGISTERED first.
       *
       * The tiebreak is the point. Without it the unprobed group has no ordering
       * at all, so Postgres returns it in whatever order the plan happens to
       * produce — on an append-only table, oldest first. An agent that registers
       * today then waits behind every agent that has ever gone unprobed, and the
       * delay between "an agent exists" and "AiKi has an opinion about it" is
       * unbounded and unrepeatable. That delay is the product's core latency and
       * it should be short and stated.
       *
       * This does not starve the backlog: probe capacity is well above the rate
       * new agents arrive, so the old unprobed set still drains, just behind
       * today's. If registrations ever outpace probing, that ceases to be true
       * and this ordering has to be revisited.
       */
      ORDER BY p.last_probed_at ASC NULLS FIRST, r.block_number DESC NULLS LAST
      LIMIT ${limit}
    `
  }

  /**
   * The dashboard's numbers, counted over every row rather than a page of them.
   *
   * `list()` is capped, and folding the dashboard out of it meant the published
   * totals shrank as the store grew. Counting here has no window: `agentsProbed`
   * is distinct agents holding a verdict, not verdicts, and `byRawState` uses
   * each agent's LATEST verdict, which is what DISTINCT ON gives.
   */
  async statsAggregate(): Promise<StatsAggregate> {
    const [indexed] = await this.sql<
      {
        total_agents: string | number
        bsc_agents: string | number
        first_block: string | number | null
        last_block: string | number | null
        last_indexed_at: string | Date | null
      }[]
    >`
      SELECT
        count(DISTINCT (chain_id, lower(registry_address), agent_id)) AS total_agents,
        count(DISTINCT (chain_id, lower(registry_address), agent_id))
          FILTER (WHERE chain_id = 56) AS bsc_agents,
        min(block_number) AS first_block,
        max(block_number) AS last_block,
        max(observed_at)  AS last_indexed_at
      FROM observations
      WHERE predicate = 'erc8004.agent_registered'
    `
    const states = await this.sql<{ state: string | null; n: string | number }[]>`
      WITH latest AS (
        SELECT DISTINCT ON (chain_id, lower(registry_address), agent_id)
          value->>'state' AS state
        FROM observations
        WHERE predicate = 'agent.liveness_verdict'
        ORDER BY chain_id, lower(registry_address), agent_id, observed_at DESC
      )
      SELECT state, count(*) AS n FROM latest GROUP BY state
    `
    const [sweep] = await this.sql<{ last_probe_sweep_at: string | Date | null }[]>`
      SELECT max(observed_at) AS last_probe_sweep_at
      FROM observations WHERE predicate = 'agent.liveness_verdict'
    `

    // Every count and every block number arrives from the driver as a string.
    // This is the same class of bug that once made lastIndexedBlock zero.
    const num = (v: string | number | null | undefined) =>
      v === null || v === undefined ? null : Number(v)
    const byRawState: Record<string, number> = {}
    let agentsProbed = 0
    for (const row of states) {
      const n = Number(row.n)
      agentsProbed += n
      byRawState[row.state ?? 'null'] = (byRawState[row.state ?? 'null'] ?? 0) + n
    }

    return {
      indexed: {
        totalAgents: num(indexed?.total_agents) ?? 0,
        bscAgents: num(indexed?.bsc_agents) ?? 0,
        firstIndexedBlock: num(indexed?.first_block),
        lastIndexedBlock: num(indexed?.last_block),
        lastIndexedAt: indexed?.last_indexed_at ? iso(indexed.last_indexed_at) : null,
      },
      probed: {
        agentsProbed,
        byRawState,
        lastProbeSweepAt: sweep?.last_probe_sweep_at ? iso(sweep.last_probe_sweep_at) : null,
      },
    }
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
  /** Read model input only; canonical facts remain append-only. */
  async list(limit = 10_000) {
    const rows = await this.sql<
      ObservationRow[]
    >`SELECT * FROM observations ORDER BY observed_at DESC LIMIT ${limit}`
    return rows.map(toObservation)
  }

  /**
   * Every observation belonging to the agents whose LATEST verdict is one of
   * `states`, chosen in SQL rather than sliced off a page.
   *
   * `list()` is `ORDER BY observed_at DESC LIMIT 10000`, and a projection built
   * over it is a moving window: once the store passed ten thousand rows, agents
   * stopped being visible in search as soon as newer observations pushed theirs
   * out. Measured on production, `/v1/stats` counted thirteen LIVE agents while
   * a search over `list()` could see four, and the four were the ones probed
   * most recently, which happened to be our own. A registry page that shows only
   * the operator's own agents as working is worse than showing nothing.
   *
   * The window is closed by selecting the AGENTS first and then taking all of
   * their rows, so an agent is either wholly present or wholly absent, never
   * half-remembered.
   */
  async observationsForLiveness(states: string[], agentLimit = 1_000) {
    if (states.length === 0) return []
    const rows = await this.sql<ObservationRow[]>`
      WITH latest AS (
        SELECT DISTINCT ON (chain_id, lower(registry_address), agent_id)
          chain_id,
          lower(registry_address) AS reg,
          agent_id,
          value->>'state' AS state,
          observed_at
        FROM observations
        WHERE predicate = 'agent.liveness_verdict'
        ORDER BY chain_id, lower(registry_address), agent_id, observed_at DESC
      ),
      picked AS (
        SELECT chain_id, reg, agent_id
        FROM latest
        WHERE state = ANY(${states})
        ORDER BY observed_at DESC
        LIMIT ${agentLimit}
      )
      SELECT o.*
      FROM observations o
      JOIN picked p
        ON o.chain_id = p.chain_id
       AND lower(o.registry_address) = p.reg
       AND o.agent_id = p.agent_id
      ORDER BY o.observed_at DESC
    `
    return rows.map(toObservation)
  }
}

interface ObservationRow {
  id: string
  subject_type: 'agent'
  chain_id: number
  registry_address: string
  agent_id: string
  predicate: string
  value: Record<string, unknown>
  valid_at: string | Date
  observed_at: string | Date
  recorded_at: string | Date
  source: string
  method: string
  evidence_class: 'A' | 'B' | 'C' | 'D'
  block_number: number | string | null
  log_index: number | string | null
  transaction_hash: string | null
  finality: 'provisional' | 'safe' | 'finalized' | null
  supersedes: string | null
  superseded_reason: string | null
  dedupe_key: string
}

/** One row shape, mapped in one place, so the two readers cannot disagree. */
function toObservation(row: ObservationRow) {
  return {
    id: row.id,
    subject: {
      type: row.subject_type,
      chainId: row.chain_id,
      registry: row.registry_address,
      agentId: row.agent_id,
    },
    predicate: row.predicate,
    value: row.value,
    validAt: iso(row.valid_at),
    observedAt: iso(row.observed_at),
    recordedAt: iso(row.recorded_at),
    source: row.source,
    method: row.method,
    evidenceClass: row.evidence_class,
    ...(row.block_number === null ? {} : { blockNumber: Number(row.block_number) }),
    ...(row.log_index === null ? {} : { logIndex: Number(row.log_index) }),
    ...(row.transaction_hash === null ? {} : { transactionHash: row.transaction_hash }),
    ...(row.finality === null ? {} : { finality: row.finality }),
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.superseded_reason === null ? {} : { supersededReason: row.superseded_reason }),
    dedupeKey: row.dedupe_key,
  }
}
