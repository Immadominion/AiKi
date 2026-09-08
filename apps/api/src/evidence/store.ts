import { randomUUID } from 'node:crypto'
import type {
  AppendResult,
  EvidenceStore,
  IndexerCheckpoint,
  NewObservation,
  Observation,
} from './types.js'

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

/** Validate invariants before a fact can enter any store implementation. */
export function materializeObservation(
  input: NewObservation,
  now = new Date().toISOString(),
): Observation {
  const recordedAt = input.recordedAt ?? now
  if (!input.predicate || !input.source || !input.method || !input.dedupeKey)
    throw new Error('Observation predicate, source, method, and dedupeKey are required.')
  if (
    !isIsoTimestamp(input.validAt) ||
    !isIsoTimestamp(input.observedAt) ||
    !isIsoTimestamp(recordedAt)
  )
    throw new Error('Observation timestamps must be ISO 8601 values.')
  if (Date.parse(recordedAt) < Date.parse(input.observedAt))
    throw new Error('Observation recordedAt cannot precede observedAt.')
  return { ...input, id: input.id ?? randomUUID(), recordedAt }
}

/** Deterministic adapter for unit tests and local wiring checks. Production uses Postgres. */
export class InMemoryEvidenceStore implements EvidenceStore {
  readonly observations: Observation[] = []
  private readonly byDedupeKey = new Map<string, Observation>()
  private readonly checkpoints = new Map<string, IndexerCheckpoint>()
  async append(input: NewObservation): Promise<AppendResult> {
    const existing = this.byDedupeKey.get(input.dedupeKey)
    if (existing) return { observation: existing, inserted: false }
    const observation = materializeObservation(input)
    this.observations.push(observation)
    this.byDedupeKey.set(observation.dedupeKey, observation)
    return { observation, inserted: true }
  }
  async getCheckpoint(stream: string): Promise<IndexerCheckpoint | null> {
    return this.checkpoints.get(stream) ?? null
  }
  async saveCheckpoint(checkpoint: IndexerCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.stream, { ...checkpoint })
  }
}
