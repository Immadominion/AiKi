import { BSC_MAINNET } from '../config/chains.js'
import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { createBscRegistrySource } from './bsc-source.js'
import { runRegistryIndexer } from './runner.js'

const rpcUrl = process.env.BSC_RPC_URL
const databaseUrl = process.env.DATABASE_URL
if (!rpcUrl || !databaseUrl) throw new Error('BSC_RPC_URL and DATABASE_URL are required.')

const initialBlock = Number(
  process.env.ERC8004_INITIAL_BLOCK ?? String(BSC_MAINNET.registryGenesisBlock),
)
if (!Number.isSafeInteger(initialBlock) || initialBlock < 0)
  throw new Error('ERC8004_INITIAL_BLOCK must be a non-negative integer.')

const store = new PostgresEvidenceStore(databaseUrl)
try {
  const result = await runRegistryIndexer(
    createBscRegistrySource({
      url: rpcUrl,
      pauseMs: Number(process.env.INDEX_PAUSE_MS ?? '1200'),
    }),
    store,
    { initialBlock, maxBlocksPerRun: Number(process.env.INDEX_MAX_BLOCKS_PER_RUN ?? '2000') },
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  await store.close()
}
