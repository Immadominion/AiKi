import type postgres from 'postgres'
import type { ExecutionState } from './attempts.js'
import { executionPending } from './attempts.js'
import type { RecoveryAttempt, RecoveryEvidence, RecoveryStore } from './reconcile.js'

interface AttemptRow {
  id: string
  authorization_id: string
  job_id: string
  chain_id: number
  executor_address: `0x${string}` | null
  state: ExecutionState
  transaction_hash: `0x${string}` | null
  created_at: Date | string
  revision: string
}

const attemptFrom = (row: AttemptRow): RecoveryAttempt => ({
  id: row.id,
  authorizationId: row.authorization_id,
  jobId: row.job_id,
  chainId: Number(row.chain_id),
  ...(row.executor_address ? { executorAddress: row.executor_address } : {}),
  state: row.state,
  ...(row.transaction_hash ? { transactionHash: row.transaction_hash } : {}),
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  revision: row.revision,
})

/** Only the attempt and its audit event change; this store cannot release spend. */
export class PostgresExecutionRecoveryStore implements RecoveryStore {
  constructor(private readonly sql: postgres.Sql) {}

  async get(attemptId: string): Promise<RecoveryAttempt | null> {
    const rows = await this.sql<AttemptRow[]>`
      SELECT *, updated_at::text AS revision FROM execution_attempts WHERE id = ${attemptId}
    `
    return rows[0] ? attemptFrom(rows[0]) : null
  }

  async finalizeSuccess(expected: RecoveryAttempt, evidence: RecoveryEvidence) {
    if (
      !expected.transactionHash ||
      expected.transactionHash.toLowerCase() !== evidence.transactionHash ||
      expected.chainId !== evidence.chainId ||
      !executionPending(expected.state)
    )
      throw new Error('Finalization evidence must match the pending execution exactly.')
    return this.sql.begin(async (tx) => {
      const rows = await tx<AttemptRow[]>`
        SELECT *, updated_at::text AS revision FROM execution_attempts
        WHERE id = ${expected.id} FOR UPDATE
      `
      const row = rows[0]
      if (
        !row ||
        row.authorization_id !== expected.authorizationId ||
        row.job_id !== expected.jobId ||
        Number(row.chain_id) !== expected.chainId ||
        (row.executor_address ?? undefined) !== expected.executorAddress ||
        row.transaction_hash !== expected.transactionHash
      )
        return 'changed' as const
      if (row.state === 'LANDED') return 'already_finalized' as const
      if (row.state !== expected.state || row.revision !== expected.revision)
        return 'changed' as const
      await tx`UPDATE execution_attempts SET state = 'LANDED', updated_at = now() WHERE id = ${expected.id}`
      const detail = `Execution landed after operator reconciliation on chain ${evidence.chainId}: ${evidence.transactionHash}. Receipt block ${evidence.blockNumber} (${evidence.blockHash}); finalized checkpoint ${evidence.finalizedBlockNumber} (${evidence.finalizedBlockHash}). Counted spend unchanged; no transaction sent.`
      await tx`INSERT INTO job_events (job_id, type, detail, at) VALUES (${expected.jobId}, 'status', ${detail}, now())`
      return 'applied' as const
    })
  }
}
