/**
 * Load the committed probe sweeps into an evidence store.
 *
 * These are real measurements, taken by this project's own prober against the
 * live BSC registry, and they are committed to the repository precisely so a
 * fresh deployment does not have to start by claiming it knows nothing. It is
 * seeding, not fabrication: every row here is an observation we actually made,
 * carrying the timestamp it was made at rather than the time it was loaded.
 *
 * Appending is idempotent on dedupeKey, so running this twice changes nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { sweepObservations } from '../prober/sweep-observations.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

const root = process.cwd()
const files = readdirSync(root).filter((name) => /^probe-sweep-.*\.json$/.test(name))
const observations = sweepObservations(
  files.map((name) => ({ name, raw: readFileSync(join(root, name), 'utf8') })),
)

const store = new PostgresEvidenceStore(databaseUrl)
let inserted = 0
try {
  for (const observation of observations)
    if ((await store.append(observation)).inserted) inserted += 1
} finally {
  await store.close()
}
console.log(
  JSON.stringify({
    files: files.length,
    observations: observations.length,
    inserted,
    agents: new Set(observations.map((o) => o.subject.agentId)).size,
  }),
)
process.exit(0)
