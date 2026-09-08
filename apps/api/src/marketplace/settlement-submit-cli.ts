import { ViemSettlementSubmitter } from './settlement-submitter.js'
import { PostgresMarketplaceSettlementWorker } from './settlement-worker.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

const rpcUrl = process.env.BSC_RPC_URL
if (!rpcUrl) throw new Error('BSC_RPC_URL is required.')

const privateKey = process.env.MARKETPLACE_SETTLEMENT_RELAYER_KEY
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey))
  throw new Error('MARKETPLACE_SETTLEMENT_RELAYER_KEY must be a 32-byte hex private key.')

const limit = Number(process.env.MARKETPLACE_SETTLEMENT_SUBMIT_LIMIT ?? '5')
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
  throw new Error('MARKETPLACE_SETTLEMENT_SUBMIT_LIMIT must be an integer from 1 to 100.')

const worker = new PostgresMarketplaceSettlementWorker(databaseUrl)
const submitter = new ViemSettlementSubmitter({
  rpcUrl,
  privateKey: privateKey as `0x${string}`,
})

let submitted = 0
try {
  for (let index = 0; index < limit; index += 1) {
    const result = await worker.submitNext(submitter)
    if (!result) break
    submitted += 1
    console.log(
      `${result.operationId} ${result.transactionHash} nonce ${result.transactionNonce ?? '?'}`,
    )
  }
} finally {
  await worker.close()
}

console.log(`done ${submitted}`)
