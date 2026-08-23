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
}
