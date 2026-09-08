/**
 * Move the indexer's resume point.
 *
 * Used once, deliberately, when the indexer has been tailing the head and
 * should instead walk the registry from its first block. Re-indexing a range
 * already covered is harmless because observations deduplicate on dedupeKey, so
 * the cost of rewinding too far is time rather than corruption.
 *
 *   INDEX_REWIND_TO=79027268 pnpm --filter @aiki/api db:reindex-from
 */
import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { REGISTRY_STREAM } from '../indexer/evidence-sink.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

const target = Number(process.env.INDEX_REWIND_TO)
if (!Number.isSafeInteger(target) || target < 0)
  throw new Error('INDEX_REWIND_TO must be a non-negative integer block number.')

const store = new PostgresEvidenceStore(databaseUrl)
try {
  const before = await store.getCheckpoint(REGISTRY_STREAM)
  // The checkpoint means "everything up to and including this block has been
  // examined", so resuming AT the target means starting from target + 1. Storing
  // target - 1 makes the next run begin exactly at the block asked for.
  await store.saveCheckpoint({
    stream: REGISTRY_STREAM,
    lastIndexedBlock: Math.max(0, target - 1),
    updatedAt: new Date().toISOString(),
  })
  console.log(
    JSON.stringify({
      stream: REGISTRY_STREAM,
      was: before?.lastIndexedBlock ?? null,
      nowResumesAt: target,
    }),
  )
} finally {
  await store.close()
}
process.exit(0)
