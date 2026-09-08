import postgres from 'postgres'
import type { ExecutionReceipt } from './service.js'
import type { ReceiptStore } from './store.js'

/** Receipts in Postgres, stored as the exact bytes that were signed. */
export class PostgresReceiptStore implements ReceiptStore {
  private readonly sql: postgres.Sql

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5 })
  }

  async put(receipt: ExecutionReceipt) {
    await this.sql`
      INSERT INTO receipts (receipt_id, job_id, mandate_hash, payload_hash, body)
      VALUES (
        ${receipt.receiptId},
        ${receipt.jobId},
        ${receipt.mandateHash},
        ${receipt.payloadHash},
        ${JSON.stringify(receipt)}
      )
      ON CONFLICT (receipt_id) DO NOTHING
    `
  }

  async get(id: string) {
    const rows = await this.sql<{ body: string }[]>`
      SELECT body FROM receipts WHERE receipt_id = ${id}
    `
    const row = rows[0]
    return row ? (JSON.parse(row.body) as ExecutionReceipt) : null
  }

  async close() {
    await this.sql.end()
  }
}
