import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { createBscRegistrySource } from './bsc-source.js'
import { runRegistryIndexer } from './runner.js'

const rpcUrl = process.env.BSC_RPC_URL
const databaseUrl = process.env.DATABASE_URL
if (!rpcUrl || !databaseUrl) throw new Error('BSC_RPC_URL and DATABASE_URL are required.')

const initialBlock = Number(process.env.ERC8004_INITIAL_BLOCK ?? '79027200')
if (!Number.isSafeInteger(initialBlock) || initialBlock < 0) throw new Error('ERC8004_INITIAL_BLOCK must be a non-negative integer.')

const store = new PostgresEvidenceStore(databaseUrl)
try {
  const result = await runRegistryIndexer(createBscRegistrySource({ url: rpcUrl }), store, { initialBlock })
  console.log(JSON.stringify(result, null, 2))
} finally {
  await store.close()
}
