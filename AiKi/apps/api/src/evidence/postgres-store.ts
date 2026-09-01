import postgres from 'postgres'
import { classifyDeclared, declaredText } from '../projections/categories.js'
import { asLiveness } from '../projections/passport.js'
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

/**
 * How many matching agents are ranked before the page is cut.
 *
 * A one-word query can match thousands of agents, and every one of them costs
 * ranking work on a route anybody can call. Stopping at a ceiling bounds that,
 * and `truncated` tells the caller the counts became a floor.
 */
const MATCH_CEILING = 2_000

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

    /*
     * Classification happens in JavaScript, over one row per agent, using the
     * SAME function the in-memory aggregate uses. Encoding the rules a second
     * time in SQL would put two regex dialects one edit apart from disagreeing,
     * which is exactly the drift the parity test between these two aggregates
     * exists to catch.
     */
    const declared = await this.sql<
      { agent_id: string; manifest: unknown; state: string | null }[]
    >`
      WITH latest_manifest AS (
        SELECT DISTINCT ON (chain_id, lower(registry_address), agent_id)
          chain_id, lower(registry_address) AS reg, agent_id, value->'manifest' AS manifest
        FROM observations
        WHERE predicate = 'erc8004.registration_resolution'
        ORDER BY chain_id, lower(registry_address), agent_id, observed_at DESC
      ),
      latest_state AS (
        SELECT DISTINCT ON (chain_id, lower(registry_address), agent_id)
          chain_id, lower(registry_address) AS reg, agent_id, value->>'state' AS state
        FROM observations
        WHERE predicate = 'agent.liveness_verdict'
        ORDER BY chain_id, lower(registry_address), agent_id, observed_at DESC
      )
      SELECT m.agent_id, m.manifest, s.state
      FROM latest_manifest m
      LEFT JOIN latest_state s
        ON s.chain_id = m.chain_id AND s.reg = m.reg AND s.agent_id = m.agent_id
      WHERE m.manifest IS NOT NULL
    `
    const categories: Record<string, { agents: number; live: number }> = {}
    for (const row of declared) {
      if (!row.manifest || typeof row.manifest !== 'object') continue
      const category = classifyDeclared(declaredText(row.manifest as Record<string, unknown>))
      const bucket = (categories[category] ??= { agents: 0, live: 0 })
      bucket.agents += 1
      if (asLiveness(row.state) === 'LIVE') bucket.live += 1
    }

    return {
      categories,
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
  /**
   * Every observation belonging to specific agents, with no window at all.
   *
   * A passport is a claim about ONE agent, so reading it off `list()`'s
   * newest-ten-thousand page made it a claim about how recently that agent
   * happened to be probed. Measured on production: `/v1/search` reported agent
   * 315943 as LIVE, named, with eight predicates, while
   * `/v1/agents/315943/passport` reported UNPROBED, no name and a zero score at
   * the same instant, because the reference agents' continuous assessments had
   * pushed its rows out of the page. UNPROBED is a positive claim — the UI
   * renders it as "No probe has ever touched it" — so the window did not make
   * the page empty, it made the page lie.
   *
   * Selecting by agent means the answer cannot depend on how busy the store has
   * been since.
   */
  async observationsForAgents(agentIds: string[]) {
    if (agentIds.length === 0) return []
    const rows = await this.sql<ObservationRow[]>`
      SELECT * FROM observations
      WHERE agent_id = ANY(${agentIds})
      ORDER BY observed_at DESC
    `
    return rows.map(toObservation)
  }

  /**
   * The agents whose own registration text matches a query, ranked, chosen in SQL.
   *
   * Three things about this are deliberate.
   *
   * It selects AGENTS and returns identities, not observations. The caller then
   * asks `observationsForAgents` for the small set it actually needs. Returning
   * every row of every match instead would put the whole ranking population
   * through `projectPassport`, which re-scans its observation array once per
   * agent: for a common word that is tens of thousands of rows and seconds of
   * blocked event loop, on a route with no authentication in front of it.
   *
   * It counts over the whole match set rather than over the returned page, so
   * `matchedBeforeFilters` and the exclusion reasons describe the population.
   * Describing a page while claiming to describe the population is the exact
   * failure this method exists to remove.
   *
   * It matches only what an agent SAYS about itself: the name, description and
   * service names in its registration file, plus its id. Nothing here is a
   * measurement of what an agent can do, because the store holds no such
   * measurement, and a search that implied otherwise would be inventing one.
   */
  async searchAgents(input: { tsquery: string; states: string[]; limit: number }) {
    const rows = await this.sql<
      {
        chain_id: number
        reg: string
        agent_id: string
        state: string
        rank: number
        wanted: boolean
      }[]
    >`
      WITH latest_state AS (
        SELECT DISTINCT ON (chain_id, lower(registry_address), agent_id)
          chain_id, lower(registry_address) AS reg, agent_id,
          value->>'state' AS state
        FROM observations
        WHERE predicate = 'agent.liveness_verdict'
        ORDER BY chain_id, lower(registry_address), agent_id, observed_at DESC
      ),
      latest_manifest AS (
        SELECT DISTINCT ON (chain_id, lower(registry_address), agent_id)
          chain_id, lower(registry_address) AS reg, agent_id,
          value->'manifest' AS m
        FROM observations
        WHERE predicate = 'erc8004.registration_resolution'
        ORDER BY chain_id, lower(registry_address), agent_id, observed_at DESC
      ),
      doc AS (
        SELECT
          s.chain_id, s.reg, s.agent_id, s.state,
          setweight(to_tsvector('simple', s.agent_id), 'D') ||
          setweight(to_tsvector('english', coalesce(m.m->>'name', '')), 'A') ||
          setweight(to_tsvector('english', coalesce(m.m->>'description', '')), 'B') ||
          setweight(to_tsvector('english', coalesce((
            -- Service names are hyphenated slugs, and a hyphen would otherwise
            -- keep "venus-health-factor-assessment" as one unsearchable token.
            SELECT string_agg(replace(sv->>'name', '-', ' '), ' ')
            FROM jsonb_array_elements(coalesce(m.m->'services', '[]'::jsonb)) sv
          ), '')), 'C') AS tsv
        FROM latest_state s
        LEFT JOIN latest_manifest m
          ON m.chain_id = s.chain_id AND m.reg = s.reg AND m.agent_id = s.agent_id
      )
      SELECT chain_id, reg, agent_id, state,
             ts_rank(tsv, q) AS rank,
             (state = ANY(${input.states})) AS wanted
      FROM doc, to_tsquery('english', ${input.tsquery}) q
      WHERE tsv @@ q
      ORDER BY wanted DESC, rank DESC, agent_id
      LIMIT ${MATCH_CEILING}
    `

    const wanted = rows.filter((row) => row.wanted)
    const excluded: Record<string, number> = {}
    for (const row of rows) {
      if (row.wanted) continue
      excluded[row.state] = (excluded[row.state] ?? 0) + 1
    }
    return {
      matches: wanted.slice(0, input.limit).map((row) => ({
        chainId: row.chain_id,
        registry: row.reg,
        agentId: row.agent_id,
      })),
      total: wanted.length,
      matchedBeforeFilters: rows.length,
      exclusionReasons: excluded,
      /*
       * True when the match set hit the ceiling, so the counts above are a floor
       * rather than a total. The caller has to say so: a truncated count printed
       * as a total is the same lie in a smaller font.
       */
      truncated: rows.length >= MATCH_CEILING,
    }
  }

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
