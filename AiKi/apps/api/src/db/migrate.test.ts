import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyMigrations,
  checksumMigration,
  migrationDirectory,
  orderMigrationNames,
  readMigrations,
} from './migrate.js'

describe('migration history', () => {
  it('orders migrations by their numeric prefix', () => {
    expect(orderMigrationNames(['010_ten.sql', '002_two.sql', '001_one.sql', 'README.md'])).toEqual(
      ['001_one.sql', '002_two.sql', '010_ten.sql'],
    )
  })

  it('rejects ambiguous migration numbers', () => {
    expect(() => orderMigrationNames(['018_kernel.sql', '018_more_kernel.sql'])).toThrow(
      'Migration number 018 is used more than once.',
    )
  })

  it('rejects filenames whose order cannot be audited', () => {
    expect(() => orderMigrationNames(['18-kernel.sql'])).toThrow('Invalid migration filename')
  })

  it('changes the checksum when any checked-in SQL byte changes', () => {
    expect(checksumMigration('SELECT 1;')).not.toBe(checksumMigration('SELECT 1;\n'))
    expect(checksumMigration('SELECT 1;')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('migration safety against PostgreSQL', () => {
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 })
  afterAll(async () => sql.end())

  it('refuses an edit to migration history after it has been applied', async () => {
    const migrations = await readMigrations(migrationDirectory)
    const changed = migrations.map((migration, index) =>
      index === 0 ? { ...migration, checksum: '0'.repeat(64) } : migration,
    )
    await expect(applyMigrations(sql, changed, () => undefined)).rejects.toThrow(
      'has changed. Add a new migration',
    )
  })

  it('refuses a build that deleted an applied migration', async () => {
    const migrations = await readMigrations(migrationDirectory)
    await expect(applyMigrations(sql, migrations.slice(1), () => undefined)).rejects.toThrow(
      'Migration history must not be deleted',
    )
  })
})
