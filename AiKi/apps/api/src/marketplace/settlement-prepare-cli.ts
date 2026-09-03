import { PostgresMarketplaceSettlementWorker } from './settlement-worker.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

const limit = Number(process.env.MARKETPLACE_SETTLEMENT_PREPARE_LIMIT ?? '25')
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
  throw new Error('MARKETPLACE_SETTLEMENT_PREPARE_LIMIT must be an integer from 1 to 1000.')

const worker = new PostgresMarketplaceSettlementWorker(databaseUrl)
let prepared = 0
try {
  for (let index = 0; index < limit; index += 1) {
    const result = (await worker.prepareNext()) ?? (await worker.prepareFundNext())
    if (!result) break
    prepared += 1
    console.log(
      `${result.replayed ? 'replayed' : 'prepared'} ${result.operationId} ${result.transaction.functionName} ${result.transaction.to}`,
    )
  }
} finally {
  await worker.close()
}

console.log(`done ${prepared}`)
