import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required to apply migrations.')

const sql = postgres(databaseUrl, { max: 1 })
const migrationDir = new URL('./migrations/', import.meta.url)

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
const names = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort()
for (const name of names) {
  const applied = await sql<
    { exists: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name = ${name}) AS exists`
  if (applied[0]?.exists) continue
  const source = await readFile(join(migrationDir.pathname, name), 'utf8')
  await sql.begin(async (tx) => {
    await tx.unsafe(source)
    await tx`INSERT INTO schema_migrations (name) VALUES (${name})`
  })
  console.log(`Applied ${name}`)
}
await sql.end()
