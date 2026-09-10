import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { a, fixture, h, yieldOp } from './receipt.test-support.js'
import { PostgresStrategyRunnerStore } from './runner-store.js'
import { simulationFixture } from './simulation.test-support.js'
import { PostgresStrategyStore } from './store.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>(),
    { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x60006000') } }
})
const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('durable strategy scheduling in isolated PostgreSQL', () => {
  const schema = `strategy_runner_qa_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql,
    sql: postgres.Sql,
    legacy: PostgresJobStore,
    jobs: JobService,
    store: PostgresStrategyStore,
    scheduler: PostgresStrategyRunnerStore
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Missing isolated database URL')
    admin = postgres(databaseUrl, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl)
    url.searchParams.set('search_path', schema)
    sql = postgres(url.toString(), { max: 8, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    legacy = new PostgresJobStore(url.toString())
    jobs = new JobService(legacy)
    store = new PostgresStrategyStore(sql)
    scheduler = new PostgresStrategyRunnerStore(sql)
  }, 30000)
  afterEach(async () => {
    await sql`TRUNCATE strategy_setup_intents,strategy_setup_actions,strategy_setups,strategy_operations,strategy_watches,execution_attempts,strategy_runner_heartbeat`
  })
  afterAll(async () => {
    await legacy?.close()
    await sql?.end()
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })
  async function setup(active = true) {
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 86400000).toISOString()
    const f = fixture({ ...yieldOp, deadline: BigInt(Math.floor(Date.now() / 1000) + 120) })
    const auth = await jobs.authorize(
      [{ kind: 'expiry', label: 'Expiry', value: expiresAt, tier: 'T0' }],
      a('99'),
    )
    const job = await jobs.createJob(auth.id, randomUUID())
    await sql`UPDATE authorizations SET status='active',delegator=${f.target.operation.binding.controller},delegation_chain_id=56,
      delegation=${sql.json({ ...f.delegation, salt: '1', epoch: '0' })} WHERE id=${auth.id}`
    const watchId = await store.registerPaused({
      jobId: job.id,
      binding: f.target.operation.binding,
      manager: f.target.manager,
      executor: f.target.executor,
      bindingEnforcer: a('34'),
      expiresAt,
      policy: { version: 1 },
      gasLimitWei: 10n ** 14n,
    })
    const { snapshot, simulation } = await simulationFixture(f.target.operation, f.delegation)
    if (active)
      await sql`UPDATE strategy_watches SET status='ACTIVE',checkpoint_nonce=7,
      chain_snapshot=${sql.json(JSON.parse(JSON.stringify(snapshot, (_, v) => (typeof v === 'bigint' ? v.toString() : v))))},
      snapshot_block=${snapshot.block.number.toString()},snapshot_hash=${snapshot.block.hash},
      snapshot_timestamp=to_timestamp(${snapshot.block.timestamp.toString()}::double precision) WHERE id=${watchId}`
    const claim = async () => {
      const [c] = await scheduler.claimDue(1)
      if (!c) throw new Error('Missing test claim')
      return c
    }
    const begin = () =>
      store.begin({
        watchId,
        expectedRevision: '0',
        operation: f.target.operation,
        envelopeHash: f.target.envelopeHash,
        manager: f.target.manager,
        executor: f.target.executor,
        simulation,
        gasBudgetWei: 6_000_000_000_000n,
      })
    return { f, auth, job, watchId, claim, begin }
  }
  it('only exposes an owner-scoped view without signed permissions', async () => {
    const f = await setup()
    expect(await scheduler.getWatchForOwner(f.watchId, a('98'))).toBeNull()
    expect(await scheduler.listForOwner(a('98'))).toEqual([])
    const visible = await scheduler.getWatchForOwner(f.watchId, a('99'))
    expect(visible).toMatchObject({
      id: f.watchId,
      chainId: 56,
      status: 'ACTIVE',
      gasLimitWei: '100000000000000',
    })
    expect(visible).not.toHaveProperty('delegation')
    expect(visible).not.toHaveProperty('executor')
  })
  it('does not schedule drafts, paused, closed, or future-due watches', async () => {
    const f = await setup(false)
    for (const status of ['PAUSED', 'CLOSED', 'NEEDS_REVIEW']) {
      await sql`UPDATE strategy_watches SET status=${status} WHERE id=${f.watchId}`
      expect(await scheduler.claimDue()).toEqual([])
    }
    await sql`UPDATE strategy_watches SET status='ACTIVE',next_run_at=now()+interval '1 hour' WHERE id=${f.watchId}`
    expect(await scheduler.claimDue()).toEqual([])
  })
  it('gives competing workers only one planning lease', async () => {
    await setup()
    const second = new PostgresStrategyRunnerStore(sql)
    const [one, two] = await Promise.all([scheduler.claimDue(1), second.claimDue(1)])
    expect(one.length + two.length).toBe(1)
    expect(await scheduler.claimDue(1)).toEqual([])
  })
  it('reclaims an expired planning lease without accepting the old planner checkpoint', async () => {
    const f = await setup(),
      old = await f.claim()
    await sql`UPDATE strategy_watches SET runner_lease_until=now()-interval '1 second' WHERE id=${f.watchId}`
    const next = await f.claim()
    expect(next.leaseId).not.toBe(old.leaseId)
    expect(
      await scheduler.savePlannerState({
        watchId: f.watchId,
        leaseId: old.leaseId,
        expectedRevision: '0',
        state: {},
      }),
    ).toBeNull()
    expect(
      await scheduler.finishPass({
        watchId: f.watchId,
        leaseId: old.leaseId,
        code: 'STALE',
        reason: 'Old pass.',
        intervalSeconds: 60,
      }),
    ).toBe(false)
  })
  it('atomically advances an observation revision only while its exact active lease is held', async () => {
    const f = await setup(),
      c = await f.claim()
    expect(
      await scheduler.savePlannerState({
        watchId: f.watchId,
        leaseId: randomUUID(),
        expectedRevision: '0',
        state: {},
      }),
    ).toBeNull()
    expect(
      await scheduler.savePlannerState({
        watchId: f.watchId,
        leaseId: c.leaseId,
        expectedRevision: '1',
        state: {},
      }),
    ).toBeNull()
    expect(
      await scheduler.savePlannerState({
        watchId: f.watchId,
        leaseId: c.leaseId,
        expectedRevision: '0',
        state: { lastObservation: { nonce: 7n } },
      }),
    ).toBe('1')
    expect(
      (await sql`SELECT planner_state FROM strategy_watches WHERE id=${f.watchId}`)[0]
        ?.planner_state,
    ).toEqual({ lastObservation: { nonce: '7' } })
    expect(
      await scheduler.savePlannerState({
        watchId: f.watchId,
        leaseId: c.leaseId,
        expectedRevision: '0',
        state: {},
      }),
    ).toBeNull()
  })
  it('cannot persist a plan after its lease expires', async () => {
    const f = await setup(),
      c = await f.claim()
    await sql`UPDATE strategy_watches SET runner_lease_until=now()-interval '1 second' WHERE id=${f.watchId}`
    expect(
      await scheduler.savePlannerState({
        watchId: f.watchId,
        leaseId: c.leaseId,
        expectedRevision: '0',
        state: {},
      }),
    ).toBeNull()
  })
  it('owner pause wins over an in-flight planner and cannot be undone by finishPass', async () => {
    const f = await setup(),
      c = await f.claim()
    await store.pause(f.watchId, a('99'))
    expect(
      await scheduler.savePlannerState({
        watchId: f.watchId,
        leaseId: c.leaseId,
        expectedRevision: '0',
        state: {},
      }),
    ).toBeNull()
    await scheduler.finishPass({
      watchId: f.watchId,
      leaseId: c.leaseId,
      code: 'STOPPED',
      reason: 'Permission needs review.',
      intervalSeconds: 60,
      stop: true,
    })
    expect((await scheduler.getWatchForOwner(f.watchId, a('99')))?.status).toBe('PAUSED')
  })
  it('pending economic intent blocks scheduling and planner checkpoints independently of lease', async () => {
    const f = await setup(),
      c = await f.claim(),
      attempt = await f.begin()
    expect(attempt.acquired).toBe(true)
    expect(
      await scheduler.savePlannerState({
        watchId: f.watchId,
        leaseId: c.leaseId,
        expectedRevision: '0',
        state: {},
      }),
    ).toBeNull()
    await sql`UPDATE strategy_watches SET runner_lease_id=NULL,runner_lease_until=NULL WHERE id=${f.watchId}`
    expect(await scheduler.claimDue()).toEqual([])
    expect(await scheduler.listPendingAttemptIds()).toEqual([])
    await sql`UPDATE execution_attempts SET updated_at=now()-interval '121 seconds' WHERE authorization_id=${f.auth.id}`
    expect(await scheduler.listPendingAttemptIds()).toEqual(
      attempt.acquired ? [attempt.attemptId] : [],
    )
  })
  it('automatic recovery never interrupts a healthy worker preparing or waiting for its receipt', async () => {
    const f = await setup()
    await f.claim()
    const attempt = await f.begin()
    expect(attempt.acquired).toBe(true)
    await sql`UPDATE execution_attempts SET updated_at=now()-interval '121 seconds' WHERE authorization_id=${f.auth.id}`
    expect(await scheduler.listPendingAttemptIds()).toEqual([])
    await sql`UPDATE strategy_watches SET runner_lease_until=now()-interval '1 second' WHERE id=${f.watchId}`
    expect(await scheduler.listPendingAttemptIds()).toEqual(
      attempt.acquired ? [attempt.attemptId] : [],
    )
  })
  it('records changed status once and schedules the next pass without duplicating activity', async () => {
    const f = await setup(),
      c = await f.claim()
    const finish = {
      watchId: f.watchId,
      leaseId: c.leaseId,
      code: 'COOLDOWN',
      reason: 'Waiting for the next check.',
      intervalSeconds: 60,
    }
    expect(await scheduler.finishPass(finish)).toBe(true)
    const row = await scheduler.getWatchForOwner(f.watchId, a('99'))
    expect(row).toMatchObject({ code: 'COOLDOWN', reason: finish.reason, status: 'ACTIVE' })
    expect(Date.parse(row?.nextRunAt ?? '') - Date.parse(row?.lastRunAt ?? '')).toBe(60000)
    await sql`UPDATE strategy_watches SET next_run_at=now() WHERE id=${f.watchId}`
    const c2 = await f.claim()
    await scheduler.finishPass({ ...finish, leaseId: c2.leaseId })
    expect(
      (
        await sql`SELECT count(*)::int AS count FROM job_events WHERE job_id=${f.job.id} AND detail=${finish.reason}`
      )[0]?.count,
    ).toBe(1)
  })
  it('requires a fresh ready heartbeat for the exact deployed configuration', async () => {
    expect((await scheduler.schedulerStatus(h('11'))).ready).toBe(false)
    const input = {
      instanceId: randomUUID(),
      configurationHash: h('11'),
      ready: true,
      reason: 'Ready.',
    }
    await scheduler.heartbeat(input)
    expect((await scheduler.schedulerStatus(h('11'))).ready).toBe(true)
    for (const invalid of [undefined, null, '0x', h('00')]) {
      expect((await scheduler.schedulerStatus(invalid as ReturnType<typeof h>)).ready).toBe(false)
    }
    expect((await scheduler.schedulerStatus(h('12'))).ready).toBe(false)
    await sql`UPDATE strategy_runner_heartbeat SET seen_at=now()-interval '121 seconds'`
    expect((await scheduler.schedulerStatus(h('11'))).ready).toBe(false)
    await scheduler.heartbeat({ ...input, ready: false })
    expect((await scheduler.schedulerStatus(h('11'))).ready).toBe(false)
  })
  it('checks bounds rather than running unbounded claims or recovery', async () => {
    await expect(scheduler.claimDue(51)).rejects.toThrow()
    await expect(scheduler.claimDue(1, 0)).rejects.toThrow()
    await expect(scheduler.listPendingAttemptIds(101)).rejects.toThrow()
  })
})
