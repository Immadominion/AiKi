import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import postgres from 'postgres'

const MIGRATION_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/
// A stable, application-specific int64. Session locks are connection-scoped,
// so every migration below must run on the same reserved connection.
const MIGRATION_LOCK_ID = '4704387908094117714'

export type Migration = {
  name: string
  checksum: string
  source: string
}

export function checksumMigration(source: string | Uint8Array): string {
  return createHash('sha256').update(source).digest('hex')
}

export function orderMigrationNames(names: string[]): string[] {
  const parsed = names
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = MIGRATION_NAME.exec(name)
      if (!match) {
        throw new Error(
          `Invalid migration filename ${name}. Expected a three-digit prefix and snake_case name.`,
        )
      }
      return { name, ordinal: Number(match[1]) }
    })
    .sort((a, b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name))

  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index]?.ordinal === parsed[index - 1]?.ordinal) {
      throw new Error(
        `Migration number ${String(parsed[index]?.ordinal).padStart(3, '0')} is used more than once.`,
      )
    }
  }

  return parsed.map(({ name }) => name)
}

export async function readMigrations(directory: URL): Promise<Migration[]> {
  const root = fileURLToPath(directory)
  const names = orderMigrationNames(await readdir(directory))
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(root, name))
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return { name, source, checksum: checksumMigration(bytes) }
    }),
  )
}

/**
 * Apply a complete migration set on one reserved PostgreSQL connection.
 *
 * The advisory lock prevents two deploys from racing. Each migration and its
 * ledger row commit together. A checksum change to applied SQL is refused,
 * because silently replaying a rewritten history is worse than a failed boot.
 */
export async function applyMigrations(
  sql: postgres.Sql,
  migrations: readonly Migration[],
  log: (message: string) => void = console.log,
): Promise<void> {
  const connection = await sql.reserve()
  let locked = false

  try {
    const lock = await connection<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${MIGRATION_LOCK_ID}::bigint) AS acquired
    `
    if (!lock[0]?.acquired) {
      throw new Error('Another AiKi deployment is applying database migrations. Retry this deploy.')
    }
    locked = true

    await connection`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `
    // Existing deployments predate checksums. The first hardened run records
    // the checked-in bytes as their baseline; every later edit is rejected.
    await connection`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`

    const knownNames = new Set(migrations.map(({ name }) => name))
    const recorded = await connection<{ name: string }[]>`SELECT name FROM schema_migrations`
    const missing = recorded.map(({ name }) => name).filter((name) => !knownNames.has(name))
    if (missing.length) {
      throw new Error(
        `Applied migrations are missing from this build: ${missing.join(', ')}. Migration history must not be deleted.`,
      )
    }

    for (const migration of migrations) {
      const rows = await connection<{ checksum: string | null }[]>`
        SELECT checksum
        FROM schema_migrations
        WHERE name = ${migration.name}
      `
      const applied = rows[0]

      if (applied) {
        if (applied.checksum === null) {
          await connection`
            UPDATE schema_migrations
            SET checksum = ${migration.checksum}
            WHERE name = ${migration.name} AND checksum IS NULL
          `
          log(`Recorded checksum for ${migration.name}`)
          continue
        }
        if (applied.checksum !== migration.checksum) {
          throw new Error(
            `Applied migration ${migration.name} has changed. Add a new migration instead of editing history.`,
          )
        }
        continue
      }

      // postgres.js reserves this exact session for the advisory lock, but its
      // reserved handle does not expose a runtime begin() method. Drive the
      // transaction explicitly so the SQL and history row use this session.
      await connection.unsafe('BEGIN')
      try {
        await connection.unsafe(migration.source)
        await connection`
          INSERT INTO schema_migrations (name, checksum)
          VALUES (${migration.name}, ${migration.checksum})
        `
        await connection.unsafe('COMMIT')
      } catch (error) {
        try {
          await connection.unsafe('ROLLBACK')
        } catch {
          // Preserve the migration error. Releasing the broken connection below
          // lets postgres.js discard it instead of hiding the original failure.
        }
        throw error
      }
      log(`Applied ${migration.name}`)
    }
  } finally {
    try {
      if (locked) {
        try {
          await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID}::bigint)`
        } catch {
          // Closing the connection releases a session lock. Do not replace a
          // useful migration error with a secondary unlock failure.
          log('Migration connection closed before its advisory lock could be released explicitly.')
        }
      }
    } finally {
      connection.release()
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required to apply migrations.')

  const sql = postgres(databaseUrl, { max: 1 })
  try {
    await applyMigrations(sql, await readMigrations(new URL('./migrations/', import.meta.url)))
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
  // postgres.js can retain a driver handle after end() on some deploy images.
  // Exiting here is safe because every migration and log write has completed.
  process.exit(0)
}

export const migrationDirectory = new URL('./migrations/', import.meta.url)
