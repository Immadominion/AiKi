import postgres from 'postgres'
import { materializeObservation } from './store.js'
import type { AppendResult, EvidenceStore, IndexerCheckpoint, NewObservation } from './types.js'

/** PostgreSQL-backed evidence store. The migration enforces append-only observations. */
export class PostgresEvidenceStore implements EvidenceStore {
  private readonly sql: postgres.Sql
  constructor(databaseUrl: string) { this.sql = postgres(databaseUrl, { max: 10, idle_timeout: 20 }) }
  async append(input: NewObservation): Promise<AppendResult> {
    const observation = materializeObservation(input)
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO observations (id, subject_type, chain_id, registry_address, agent_id, predicate, value, valid_at, observed_at, recorded_at, source, method, evidence_class, block_number, log_index, transaction_hash, finality, supersedes, superseded_reason, dedupe_key)
      VALUES (${observation.id}, ${observation.subject.type}, ${observation.subject.chainId}, ${observation.subject.registry.toLowerCase()}, ${observation.subject.agentId}, ${observation.predicate}, ${this.sql.json(observation.value as unknown as postgres.JSONValue)}, ${observation.validAt}, ${observation.observedAt}, ${observation.recordedAt}, ${observation.source}, ${observation.method}, ${observation.evidenceClass}, ${observation.blockNumber ?? null}, ${observation.logIndex ?? null}, ${observation.transactionHash ?? null}, ${observation.finality ?? null}, ${observation.supersedes ?? null}, ${observation.supersededReason ?? null}, ${observation.dedupeKey})
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
    `
    return { observation, inserted: rows.length === 1 }
  }
  async getCheckpoint(stream: string): Promise<IndexerCheckpoint | null> {
    const rows = await this.sql<IndexerCheckpoint[]>`SELECT stream, last_indexed_block AS "lastIndexedBlock", updated_at AS "updatedAt" FROM indexer_checkpoints WHERE stream = ${stream}`
    return rows[0] ?? null
  }
  async saveCheckpoint(checkpoint: IndexerCheckpoint): Promise<void> {
    await this.sql`INSERT INTO indexer_checkpoints (stream, last_indexed_block, updated_at) VALUES (${checkpoint.stream}, ${checkpoint.lastIndexedBlock}, ${checkpoint.updatedAt}) ON CONFLICT (stream) DO UPDATE SET last_indexed_block = EXCLUDED.last_indexed_block, updated_at = EXCLUDED.updated_at`
  }
  async close(): Promise<void> { await this.sql.end() }
  /** Read model input only; canonical facts remain append-only. */
  async list(limit = 10_000) {
    const rows = await this.sql<{
      id: string; subject_type: 'agent'; chain_id: number; registry_address: string; agent_id: string; predicate: string; value: Record<string, unknown>; valid_at: string; observed_at: string; recorded_at: string; source: string; method: string; evidence_class: 'A' | 'B' | 'C' | 'D'; block_number: number | null; log_index: number | null; transaction_hash: string | null; finality: 'provisional' | 'safe' | 'finalized' | null; supersedes: string | null; superseded_reason: string | null; dedupe_key: string
    }[]>`SELECT * FROM observations ORDER BY observed_at DESC LIMIT ${limit}`
    return rows.map((row) => ({ id: row.id, subject: { type: row.subject_type, chainId: row.chain_id, registry: row.registry_address, agentId: row.agent_id }, predicate: row.predicate, value: row.value, validAt: row.valid_at, observedAt: row.observed_at, recordedAt: row.recorded_at, source: row.source, method: row.method, evidenceClass: row.evidence_class, ...(row.block_number === null ? {} : { blockNumber: row.block_number }), ...(row.log_index === null ? {} : { logIndex: row.log_index }), ...(row.transaction_hash === null ? {} : { transactionHash: row.transaction_hash }), ...(row.finality === null ? {} : { finality: row.finality }), ...(row.supersedes === null ? {} : { supersedes: row.supersedes }), ...(row.superseded_reason === null ? {} : { supersededReason: row.superseded_reason }), dedupeKey: row.dedupe_key }))
  }
}
