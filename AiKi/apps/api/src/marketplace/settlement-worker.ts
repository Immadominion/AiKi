import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { type PreparedApexTransaction, prepareApexCreateEscrow } from './apex.js'
import { settlementRailFor } from './settlement-rails.js'

type QueueRow = {
  outbox_id: string
  operation_id: string
  job_id: string
  agreement_id: string
  operation_status: 'REQUESTED' | 'PREPARED'
  chain_id: string | number
  contract_address: `0x${string}`
  token_address: `0x${string}`
  payee_address: `0x${string}`
  settlement_decimals: number
  hard_expiry: Date | string
  terms_hash: string
  prepared_transaction: PreparedApexTransaction | null
}

export type PreparedSettlementOperation = Readonly<{
  outboxId: string
  operationId: string
  jobId: string
  agreementId: string
  transaction: PreparedApexTransaction
  replayed: boolean
}>

const isoError = (error: unknown): string =>
  error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()

export class PostgresMarketplaceSettlementWorker {
  private readonly sql: postgres.Sql

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 3 })
  }

  async close(): Promise<void> {
    await this.sql.end()
  }

  async prepareNext(
    workerId = `marketplace-settlement-${randomUUID()}`,
  ): Promise<PreparedSettlementOperation | null> {
    return this.sql.begin(async (tx) => {
      const locked = await tx<{ id: string }[]>`
        SELECT id
        FROM outbox_events
        WHERE topic = 'marketplace.settlement.create.requested'
          AND status = 'PENDING'
          AND available_at <= now()
        ORDER BY available_at ASC, created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `
      const outboxId = locked[0]?.id
      if (!outboxId) return null

      await tx`
        UPDATE outbox_events
        SET status = 'PROCESSING',
            attempts = attempts + 1,
            locked_at = now(),
            locked_by = ${workerId},
            updated_at = now()
        WHERE id = ${outboxId}
      `

      try {
        const rows = await tx<QueueRow[]>`
          SELECT
            o.id AS outbox_id,
            so.id AS operation_id,
            so.job_id,
            so.agreement_id,
            so.status AS operation_status,
            so.chain_id,
            so.contract_address,
            so.token_address,
            so.prepared_transaction,
            ja.payee_address,
            ja.settlement_decimals,
            ja.hard_expiry,
            ja.terms_hash
          FROM outbox_events o
          JOIN settlement_operations so ON so.id = (o.payload ->> 'operationId')::uuid
          JOIN job_agreements ja ON ja.id = so.agreement_id
          WHERE o.id = ${outboxId}
            AND so.operation_type = 'CREATE_ESCROW'
          FOR UPDATE OF so, ja
        `
        const row = rows[0]
        if (!row) throw new Error('Settlement outbox event does not point at a create operation.')

        if (row.operation_status === 'PREPARED' && row.prepared_transaction) {
          await markDelivered(tx, outboxId)
          return {
            outboxId,
            operationId: row.operation_id,
            jobId: row.job_id,
            agreementId: row.agreement_id,
            transaction: row.prepared_transaction,
            replayed: true,
          }
        }

        const rail = settlementRailFor({
          chainId: Number(row.chain_id),
          token: row.token_address,
          decimals: row.settlement_decimals,
        })
        if (rail.contract !== row.contract_address)
          throw new Error(`Settlement contract mismatch for operation ${row.operation_id}.`)

        const transaction = prepareApexCreateEscrow({
          rail,
          jobId: row.job_id,
          agreementId: row.agreement_id,
          provider: row.payee_address,
          hardExpiry: iso(row.hard_expiry),
          termsHash: row.terms_hash,
        })

        await tx`
          UPDATE settlement_operations
          SET status = 'PREPARED',
              prepared_transaction = ${tx.json(transaction)},
              prepared_at = now(),
              updated_at = now()
          WHERE id = ${row.operation_id}
            AND status = 'REQUESTED'
        `
        await markDelivered(tx, outboxId)
        return {
          outboxId,
          operationId: row.operation_id,
          jobId: row.job_id,
          agreementId: row.agreement_id,
          transaction,
          replayed: false,
        }
      } catch (error) {
        await tx`
          UPDATE outbox_events
          SET status = 'DEAD_LETTER',
              last_error = ${isoError(error)},
              locked_at = NULL,
              locked_by = NULL,
              updated_at = now()
          WHERE id = ${outboxId}
        `
        throw error
      }
    })
  }
}

async function markDelivered(tx: postgres.TransactionSql, outboxId: string): Promise<void> {
  await tx`
    UPDATE outbox_events
    SET status = 'DELIVERED',
        locked_at = NULL,
        locked_by = NULL,
        delivered_at = now(),
        updated_at = now()
    WHERE id = ${outboxId}
  `
}
