import { ViemSettlementFinalityReader } from './settlement-finality.js'
import { PostgresMarketplaceSettlementWorker } from './settlement-worker.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

const rpcUrl = process.env.BSC_RPC_URL
if (!rpcUrl) throw new Error('BSC_RPC_URL is required.')

const limit = Number(process.env.MARKETPLACE_SETTLEMENT_FINALIZE_LIMIT ?? '25')
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
  throw new Error('MARKETPLACE_SETTLEMENT_FINALIZE_LIMIT must be an integer from 1 to 1000.')

const worker = new PostgresMarketplaceSettlementWorker(databaseUrl)
const reader = new ViemSettlementFinalityReader(rpcUrl)
let finalized = 0
try {
  for (let index = 0; index < limit; index += 1) {
    const result = await worker.finalizeNext(reader)
    if (!result) break
    finalized += 1
    console.log(`${result.operationId} external job ${result.externalJobId}`)
  }
} finally {
  await worker.close()
}

console.log(`done ${finalized}`)
