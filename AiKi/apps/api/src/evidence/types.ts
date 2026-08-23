import type { EvidenceClass, Finality, Timestamp } from '@aiki/contracts'

export interface AgentSubject {
  type: 'agent'
  chainId: number
  registry: string
  agentId: string
}
export type EvidenceSubject = AgentSubject

/** Immutable source fact. Passports and scores are rebuildable projections of this table. */
export interface Observation {
  id: string
  subject: EvidenceSubject
  predicate: string
  value: Record<string, unknown>
  validAt: Timestamp
  observedAt: Timestamp
  recordedAt: Timestamp
  source: string
  method: string
  evidenceClass: EvidenceClass
  blockNumber?: number
  logIndex?: number
  transactionHash?: string
  finality?: Finality
  supersedes?: string
  supersededReason?: string
  /** Stable source identity; duplicate delivery of the same fact must be harmless. */
  dedupeKey: string
}

export type NewObservation = Omit<Observation, 'id' | 'recordedAt'> & {
  id?: string
  recordedAt?: Timestamp
}
export interface IndexerCheckpoint {
  stream: string
  lastIndexedBlock: number
  updatedAt: Timestamp
}
export interface AppendResult {
  observation: Observation
  inserted: boolean
}
export interface EvidenceStore {
  append(input: NewObservation): Promise<AppendResult>
  getCheckpoint(stream: string): Promise<IndexerCheckpoint | null>
  saveCheckpoint(checkpoint: IndexerCheckpoint): Promise<void>
}
