import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { checkLedger } from './reconcile.js'
import { ISSUANCE_ACCOUNT, PostgresCreditStore } from './store.js'

const databaseUrl = process.env.DATABASE_URL
const mainnetToken = `0x${'ab'.repeat(20)}`
const testnetToken = `0x${'cd'.repeat(20)}`
const treasury = `0x${'ef'.repeat(20)}`
const rail = { chainId: 56, token: mainnetToken, treasury }
const allPaidCheck = 'every point somebody paid for is still backed'
const currentCheck = 'paid points on the current payment rail are backed'
const historicalCheck = 'paid points on other or unknown payment rails are verified'

describe.skipIf(!databaseUrl)('payment-rail reconciliation against PostgreSQL', () => {
  const schema = `reconcile_qa_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql
  let sql: postgres.Sql
  let credits: PostgresCreditStore

  beforeAll(async () => {
    admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl as string)
    // No public fallback: an existing public migration ledger must never make
    // this suite skip its own tables and then truncate another suite's data.
    url.searchParams.set('search_path', schema)
    sql = postgres(url.toString(), { max: 2, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS schema`)[0]?.schema).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    credits = new PostgresCreditStore(url.toString())
  }, 30_000)

  beforeEach(async () => {
    await sql`TRUNCATE credit_entries, credit_balances`
  })

  afterAll(async () => {
    await Promise.all([credits?.close(), sql?.end()])
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })

  const deposit = (points: number, detail: Record<string, unknown> = {}) =>
    credits.deposit({
      owner: `0x${'11'.repeat(20)}`,
      points,
      reason: 'deposit',
      reference: randomUUID(),
      detail,
    })
  const finding = (findings: Awaited<ReturnType<typeof checkLedger>>, check: string) => {
    const found = findings.find((entry) => entry.check === check)
    if (!found) throw new Error(`Missing reconciliation check: ${check}`)
    return found
  }

  it('does not use mainnet backing to verify historical testnet deposits', async () => {
    await deposit(3000, { chainId: 97, token: testnetToken, baseUnits: '3000000' })
    await deposit(2000, { chainId: 56, token: mainnetToken, baseUnits: '2000000000000000000' })
    const before = await sql`SELECT * FROM credit_entries ORDER BY id`
    const findings = await checkLedger(sql, 5000, rail)
    expect(finding(findings, allPaidCheck).ok).toBe(false)
    expect(finding(findings, currentCheck)).toMatchObject({ ok: true })
    expect(finding(findings, currentCheck).detail).toContain('2000 points sold')
    expect(finding(findings, historicalCheck)).toMatchObject({ ok: false })
    expect(finding(findings, historicalCheck).detail).toContain('3000 points')
    expect(finding(findings, historicalCheck).detail).toContain('chain 97')
    expect(finding(findings, historicalCheck).detail).toContain('unverified')
    expect(await sql`SELECT * FROM credit_entries ORDER BY id`).toEqual(before)
    expect(await credits.balance(`0x${'11'.repeat(20)}`)).toBe(5000)
    expect(
      findings
        .filter((entry) => ![allPaidCheck, currentCheck, historicalCheck].includes(entry.check))
        .every((entry) => entry.ok),
    ).toBe(true)
  })

  it('verifies mixed liabilities against independent original-rail observations without rewriting points', async () => {
    await deposit(3000, { chainId: 97, token: testnetToken, baseUnits: '3000000' })
    await deposit(2000, { chainId: 56, token: mainnetToken, baseUnits: '2000000000000000000' })
    const before = await sql`SELECT * FROM credit_entries ORDER BY id`
    const findings = await checkLedger(sql, 2000, rail, [
      { chainId: 97, token: testnetToken, treasury, backingPoints: 3000 },
    ])
    expect(findings.every((entry) => entry.ok)).toBe(true)
    expect(finding(findings, historicalCheck).detail).toContain('3000 points of backing')
    expect(finding(findings, historicalCheck).detail).toContain('chain 97')
    expect(finding(findings, allPaidCheck).detail).toContain('each original payment rail')
    expect(await sql`SELECT * FROM credit_entries ORDER BY id`).toEqual(before)
    expect(await credits.balance(`0x${'11'.repeat(20)}`)).toBe(5000)
  })

  it.each([null, 2999, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'does not verify a historical liability against invalid or insufficient backing %s',
    async (backingPoints) => {
      await deposit(3000, { chainId: 97, token: testnetToken })
      const findings = await checkLedger(sql, 1_000_000, rail, [
        { chainId: 97, token: testnetToken, treasury, backingPoints },
      ])
      expect(finding(findings, historicalCheck).ok).toBe(false)
      expect(finding(findings, allPaidCheck).ok).toBe(false)
    },
  )

  it('does not use historical testnet backing to cover a mainnet shortfall', async () => {
    await deposit(3000, { chainId: 97, token: testnetToken })
    await deposit(2000, { chainId: 56, token: mainnetToken })
    const findings = await checkLedger(sql, 1999, rail, [
      { chainId: 97, token: testnetToken, treasury, backingPoints: 1_000_000 },
      { ...rail, backingPoints: 1_000_000 },
    ])
    expect(finding(findings, historicalCheck).ok).toBe(true)
    expect(finding(findings, currentCheck).ok).toBe(false)
    expect(finding(findings, allPaidCheck).ok).toBe(false)
  })

  it('keeps unknown metadata unverified even when every configured treasury has backing', async () => {
    await deposit(3000, { chainId: 97, token: testnetToken })
    await deposit(100)
    const findings = await checkLedger(sql, 10_000, rail, [
      { chainId: 97, token: testnetToken, treasury, backingPoints: 10_000 },
    ])
    expect(finding(findings, historicalCheck).ok).toBe(false)
    expect(finding(findings, historicalCheck).detail).toContain('100 points')
    expect(finding(findings, historicalCheck).detail).toContain('unknown')
    expect(finding(findings, allPaidCheck).ok).toBe(false)
  })

  it('does not pool duplicate historical observations or match a different chain/token', async () => {
    await deposit(3000, { chainId: 97, token: testnetToken })
    for (const observations of [
      [
        { chainId: 97, token: testnetToken, treasury, backingPoints: 3000 },
        { chainId: 97, token: testnetToken, treasury, backingPoints: 3000 },
      ],
      [
        { chainId: 97, token: testnetToken, treasury, backingPoints: 3000 },
        { chainId: 97, token: testnetToken, treasury, backingPoints: null },
      ],
      [{ chainId: 56, token: testnetToken, treasury, backingPoints: 3000 }],
      [{ chainId: 97, token: mainnetToken, treasury, backingPoints: 3000 }],
    ]) {
      const findings = await checkLedger(sql, 3000, rail, observations)
      expect(finding(findings, historicalCheck).ok).toBe(false)
      expect(finding(findings, allPaidCheck).ok).toBe(false)
    }
  })

  it('keeps historical point liabilities beyond safe integer precision unverified', async () => {
    await deposit(3000, { chainId: 97, token: testnetToken })
    await sql`
      UPDATE credit_entries SET delta = CASE WHEN owner = ${ISSUANCE_ACCOUNT}
        THEN -9007199254740993::bigint ELSE 9007199254740993::bigint END
    `
    const findings = await checkLedger(sql, 0, rail, [
      { chainId: 97, token: testnetToken, treasury, backingPoints: Number.MAX_SAFE_INTEGER },
    ])
    expect(finding(findings, historicalCheck).ok).toBe(false)
    expect(finding(findings, allPaidCheck).ok).toBe(false)
  })

  it.each([
    {},
    { chainId: 56 },
    { token: mainnetToken },
    { chainId: 'unrecorded', token: mainnetToken },
    { chainId: 56, token: 'USDT' },
  ])('keeps incomplete or malformed deposit metadata unverified: %j', async (detail) => {
    await deposit(800, detail)
    const findings = await checkLedger(sql, 800, rail)
    expect(finding(findings, currentCheck).detail).toContain('0 points sold')
    expect(finding(findings, historicalCheck)).toMatchObject({ ok: false })
    expect(finding(findings, historicalCheck).detail).toContain('800 points')
    expect(finding(findings, historicalCheck).detail).toContain('unknown')
    expect(finding(findings, allPaidCheck).ok).toBe(false)
  })

  it('does not count a different token on the same chain as the configured backing asset', async () => {
    await deposit(700, { chainId: 56, token: testnetToken })
    const findings = await checkLedger(sql, 700, rail)
    expect(finding(findings, currentCheck).detail).toContain('0 points sold')
    expect(finding(findings, historicalCheck).detail).toContain(testnetToken)
    expect(finding(findings, allPaidCheck).ok).toBe(false)
  })

  it('classifies payer metadata case-insensitively without counting its metadata-free issuance leg', async () => {
    await deposit(500, { chainId: '56', token: mainnetToken.toUpperCase().replace('0X', '0x') })
    await credits.deposit({
      owner: `0x${'11'.repeat(20)}`,
      points: 100,
      reason: 'welcome',
      reference: randomUUID(),
    })
    const findings = await checkLedger(sql, 500, rail)
    expect(finding(findings, currentCheck)).toMatchObject({ ok: true })
    expect(finding(findings, currentCheck).detail).toContain('500 points sold')
    expect(finding(findings, currentCheck).detail).toContain(treasury)
    expect(finding(findings, historicalCheck).ok).toBe(true)
    expect(finding(findings, allPaidCheck).ok).toBe(true)
    expect(finding(findings, allPaidCheck).detail).toContain('100')
  })

  it.each([0, 499, null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not verify a 500-point liability against insufficient or unavailable backing %s',
    async (backing) => {
      await deposit(500, { chainId: 56, token: mainnetToken })
      const findings = await checkLedger(sql, backing, rail)
      expect(finding(findings, currentCheck).ok).toBe(false)
      expect(finding(findings, allPaidCheck).ok).toBe(false)
    },
  )

  it('verifies an empty current rail with measured zero backing but not an unread treasury', async () => {
    expect((await checkLedger(sql, 0, rail)).every((entry) => entry.ok)).toBe(true)
    const unavailable = await checkLedger(sql, null, rail)
    expect(finding(unavailable, currentCheck).ok).toBe(false)
    expect(finding(unavailable, allPaidCheck).ok).toBe(false)
  })

  it('does not hide issuance that cannot be matched to positive payer deposit entries', async () => {
    await deposit(500, { chainId: 56, token: mainnetToken })
    await sql`UPDATE credit_entries SET delta = -800 WHERE owner = ${ISSUANCE_ACCOUNT}`
    const findings = await checkLedger(sql, 800, rail)
    expect(finding(findings, allPaidCheck).ok).toBe(false)
    expect(finding(findings, allPaidCheck).detail).toContain('800')
    expect(finding(findings, allPaidCheck).detail).toContain('500')
  })

  it('preserves the existing aggregate check when no payment rail is supplied', async () => {
    await deposit(3000, { chainId: 97, token: testnetToken })
    await deposit(2000)
    const backed = await checkLedger(sql, 5000)
    expect(backed).toHaveLength(8)
    expect(finding(backed, allPaidCheck)).toEqual({
      check: allPaidCheck,
      ok: true,
      detail:
        '5000 points sold and 5000 points of backing held; 0 more were granted, which AiKi carries',
    })
    expect(finding(await checkLedger(sql, 4999), allPaidCheck).ok).toBe(false)
    expect(finding(await checkLedger(sql), allPaidCheck).ok).toBe(false)
  })
})
