import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import type { DeploymentAttempt } from './attempts.js'
import { PostgresAccountStore } from './store.js'

const databaseUrl = process.env.DATABASE_URL
const address = () => `0x${randomUUID().replaceAll('-', '')}12345678` as `0x${string}`
const hash = `0x${'ab'.repeat(32)}` as const

describe.skipIf(!databaseUrl)('durable account deployments in isolated PostgreSQL', () => {
  const schema = `account_deployment_qa_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql
  let sql: postgres.Sql
  let store: PostgresAccountStore
  let other: PostgresAccountStore

  beforeAll(async () => {
    admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl as string)
    url.searchParams.set('search_path', schema)
    sql = postgres(url.toString(), { max: 3, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS schema`)[0]?.schema).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    store = new PostgresAccountStore(url.toString())
    other = new PostgresAccountStore(url.toString())
  }, 30_000)

  afterAll(async () => {
    await Promise.all([store?.close(), other?.close(), sql?.end()])
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })

  const attempt = (patch: Partial<DeploymentAttempt> = {}): DeploymentAttempt => ({
    id: randomUUID(),
    owner: address(),
    funder: address(),
    manager: address(),
    chainId: 56,
    state: 'PREPARING',
    createdAt: new Date().toISOString(),
    ...patch,
  })
  async function prepared() {
    const a = attempt()
    expect(await store.beginDeployment(a)).toBe(true)
    a.transactionHash = hash
    a.expectedAddress = address()
    await store.recordDeploymentHash(a.id, hash, a.expectedAddress)
    return a
  }

  it('permits one deployment across owners sharing a funder and independent database pools', async () => {
    const a = attempt()
    const b = attempt({ funder: a.funder })
    expect(
      (await Promise.all([store.beginDeployment(a), other.beginDeployment(b)])).filter(Boolean),
    ).toHaveLength(1)
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM account_deployment_attempts WHERE funder = ${a.funder}`
      )[0]?.count,
    ).toBe(1)
  })

  it('permits one deployment for the same owner even if the configured funder changed', async () => {
    const a = attempt()
    const b = attempt({ owner: a.owner })
    expect(
      (await Promise.all([store.beginDeployment(a), other.beginDeployment(b)])).filter(Boolean),
    ).toHaveLength(1)
  })

  it('retains hash and sender lock across connection restart without expiring uncertainty', async () => {
    const a = await prepared()
    await store.finishDeployment(a.id, 'UNCONFIRMED')
    expect(await other.pendingDeployment(a.owner, 56)).toMatchObject({
      id: a.id,
      transactionHash: hash,
      expectedAddress: a.expectedAddress,
      state: 'UNCONFIRMED',
    })
    expect(await other.beginDeployment(attempt({ funder: a.funder }))).toBe(false)
  })

  it('persists account and terminal state together, idempotently across concurrent callers', async () => {
    const a = await prepared()
    const results = await Promise.all([store.finalizeDeployment(a), other.finalizeDeployment(a)])
    expect(results[0]).toEqual(results[1])
    expect(await store.pendingDeployment(a.owner, 56)).toBeNull()
    expect(await store.find(a.owner, 56)).toMatchObject({
      address: a.expectedAddress,
      deployedTx: hash,
    })
    expect(await other.beginDeployment(attempt({ owner: a.owner }))).toBe(false)
    expect(await other.beginDeployment(attempt({ funder: a.funder }))).toBe(true)
  })

  it('keeps the signer lock if account insertion fails, without partially finalizing', async () => {
    const a = await prepared()
    await sql`CREATE FUNCTION reject_account_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'LANDED' THEN RAISE EXCEPTION 'fixture rejects finalization'; END IF; RETURN NEW; END $$`
    await sql`CREATE TRIGGER reject_fixture_terminal BEFORE UPDATE ON account_deployment_attempts FOR EACH ROW EXECUTE FUNCTION reject_account_terminal()`
    try {
      await expect(store.finalizeDeployment(a)).rejects.toBeDefined()
      expect(await store.find(a.owner, 56)).toBeNull()
      expect((await store.pendingDeployment(a.owner, 56))?.id).toBe(a.id)
      expect(await other.beginDeployment(attempt({ funder: a.funder }))).toBe(false)
    } finally {
      await sql`DROP TRIGGER reject_fixture_terminal ON account_deployment_attempts`
      await sql`DROP FUNCTION reject_account_terminal()`
    }
  })

  it('never overwrites a different account or finalizes against changed hash/owner/manager', async () => {
    const a = await prepared()
    for (const patch of [
      { transactionHash: `0x${'cd'.repeat(32)}` as const },
      { owner: address() },
      { manager: address() },
      { funder: address() },
      { expectedAddress: address() },
    ])
      await expect(store.finalizeDeployment({ ...a, ...patch })).rejects.toThrow('changed')
    await store.claim({
      owner: a.owner,
      chainId: 56,
      address: address(),
      deployedTx: hash,
      createdAt: a.createdAt,
    })
    await expect(store.finalizeDeployment(a)).rejects.toThrow('different account')
    expect((await store.pendingDeployment(a.owner, 56))?.id).toBe(a.id)
  })

  it('keeps signed hash and expected CREATE address immutable', async () => {
    const a = await prepared()
    if (!a.expectedAddress) throw new Error('Incomplete fixture')
    await expect(
      store.recordDeploymentHash(a.id, `0x${'cd'.repeat(32)}`, a.expectedAddress),
    ).rejects.toThrow('cannot be changed')
    await expect(store.recordDeploymentHash(a.id, hash, address())).rejects.toThrow(
      'cannot be changed',
    )
    expect((await store.pendingDeployment(a.owner, 56))?.transactionHash).toBe(hash)
  })

  it('does not deploy again when a prior finalization commits while the caller waits', async () => {
    const a = await prepared()
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const finalized = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1095322442, 56)`
      await tx`INSERT INTO mandate_accounts (owner, chain_id, address, deployed_tx, created_at) VALUES (${a.owner}, 56, ${a.expectedAddress ?? ''}, ${hash}, now())`
      await tx`UPDATE account_deployment_attempts SET state = 'LANDED' WHERE id = ${a.id}`
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await ready
    const retry = other.beginDeployment(attempt({ owner: a.owner, funder: a.funder }))
    // Allow the competing query to reach PostgreSQL while finalization is held.
    await new Promise((resolve) => setTimeout(resolve, 25))
    release()
    await finalized
    expect(await retry).toBe(false)
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM account_deployment_attempts WHERE owner = ${a.owner}`
      )[0]?.count,
    ).toBe(1)
  })
})
