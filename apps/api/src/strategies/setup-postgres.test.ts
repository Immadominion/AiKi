import { randomUUID } from 'node:crypto'
import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  type SignedDelegation,
} from '@aiki/contracts'
import type { PreparedStrategyDeployment } from '@aiki/contracts/strategies'
import postgres from 'postgres'
import { type Hex, hashStruct, hashTypedData } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyMigrations, readMigrations } from '../db/migrate.js'
import {
  finalizeStrategyDeployment,
  prepareStrategyDeployment,
  readStrategySetupSnapshot,
} from './deployment.js'
import { deploymentFixture } from './deployment.test-support.js'
import { strategyDeploymentConfigDigest } from './deployment-config.js'
import { deploymentRequestDigest } from './deployment-policy.js'
import { verifyStrategyDeploymentConfiguration } from './deployment-verification.js'
import { PostgresStrategyRunnerStore } from './runner-store.js'
import { type StrategySetupReader, StrategySetupService } from './setup.js'
import { STRATEGY_EXPIRY_ENFORCER } from './setup-readiness.js'
import { PostgresStrategySetupStore, setupDigest, setupJSON } from './setup-store.js'
import { snapshotFixture } from './snapshot.test-support.js'
import { PostgresStrategyStore } from './store.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{
      default: { enforcers: Array<{ name: string; address: string; codeHash: string }> }
    }>(),
    { keccak256 } = await import('viem')
  return {
    default: {
      ...original.default,
      managerCodeHash: keccak256('0x6005'),
      enforcers: original.default.enforcers.map((pin) =>
        pin.name === 'ExpiryEnforcer' ? { ...pin, codeHash: keccak256('0x6006') } : pin,
      ),
    },
  }
})
// Deployment-specific runtime verification has its own artifact-backed suite. Here only
// its boundary is mocked; authority/snapshot issuance, SQL and registration are real.
vi.mock('./deployment.js', () => ({
  prepareStrategyDeployment: vi.fn(),
  finalizeStrategyDeployment: vi.fn(),
  readStrategySetupSnapshot: vi.fn(),
}))
vi.mock('./deployment-verification.js', async (importOriginal) => {
  const original = await importOriginal<object>()
  return { ...original, verifyStrategyDeploymentConfiguration: vi.fn() }
})
const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Setup regressions require a loopback test database.')
const h = (b: string) => `0x${b.repeat(32)}` as Hex,
  other = `0x${'88'.repeat(20)}` as Hex,
  executor = `0x${'66'.repeat(20)}` as Hex
const signature = `0x${'0'.repeat(63)}1${'0'.repeat(63)}11b` as Hex

describe.skipIf(!databaseUrl)('owner strategy setup in isolated PostgreSQL', () => {
  const schema = `strategy_setup_${randomUUID().replaceAll('-', '')}`
  let admin: postgres.Sql,
    sql: postgres.Sql,
    store: PostgresStrategySetupStore,
    strategies: PostgresStrategyStore
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Missing local DB')
    admin = postgres(databaseUrl, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const url = new URL(databaseUrl)
    url.searchParams.set('search_path', schema)
    sql = postgres(url.toString(), { max: 10, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    store = new PostgresStrategySetupStore(sql)
    strategies = new PostgresStrategyStore(sql)
  }, 30000)
  afterEach(async () => {
    vi.restoreAllMocks()
    await sql`TRUNCATE strategy_setups,strategy_setup_intents,strategy_setup_actions,strategy_watches,strategy_operations,execution_attempts,authorizations,jobs,job_events,strategy_runner_heartbeat CASCADE`
  })
  afterAll(async () => {
    await sql?.end()
    if (admin) {
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      await admin.end()
    }
  })
  async function fixture() {
    const d = deploymentFixture(),
      now = Math.floor(Date.now() / 1000)
    d.input.common.expiresAt = String(now + 86400)
    const f = snapshotFixture('yield', {
      owner: d.owner,
      timestamp: BigInt(now),
      expiresAt: BigInt(now + 86400),
      paused: true,
    })
    f.setVault('limits', [1000n, 100n, 2000n, 10n, 900n, 900n, 1n, 10n, 100])
    const proof = async () => {
      const result = await f.run()
      if (result.status !== 'verified') throw new Error('Bad fixture proof')
      return result.snapshot
    }
    const snapshot = await proof(),
      input = { ...d.input, controller: snapshot.binding.controller },
      factory = d.config.factories.yield.address
    const fixed = {
      version: 1 as const,
      chainId: 56 as const,
      kind: 'yield' as const,
      owner: d.owner,
      controller: input.controller,
      input,
      configurationDigest: strategyDeploymentConfigDigest(d.config),
      policyHash: snapshot.binding.policyHash,
      predictedVault: snapshot.binding.vault,
      unsignedTransaction: {
        chainId: 56 as const,
        from: d.owner,
        to: factory,
        data: '0x12345678' as Hex,
        value: '0' as const,
      },
    }
    const prepared: PreparedStrategyDeployment = {
      ...fixed,
      requestDigest: deploymentRequestDigest(fixed),
      block: { number: '100', hash: snapshot.block.hash, timestamp: String(now) },
      alreadyDeployed: false,
    }
    vi.mocked(prepareStrategyDeployment).mockResolvedValue({ status: 'prepared', prepared })
    vi.mocked(readStrategySetupSnapshot).mockImplementation(async () => ({
      status: 'verified',
      snapshot: await proof(),
    }))
    vi.mocked(verifyStrategyDeploymentConfiguration).mockResolvedValue({
      config: d.config,
      block: { number: 100n, hash: snapshot.block.hash, timestamp: BigInt(now) },
    })
    vi.mocked(finalizeStrategyDeployment).mockResolvedValue({
      status: 'verified',
      binding: { ...snapshot.binding },
      owner: d.owner,
      requestDigest: prepared.requestDigest,
      transactionHash: h('77'),
      block: prepared.block,
      retry: false,
    })
    const chain = { epoch: 0n, disabled: false, valid: true, owner: d.owner, native: 10n ** 18n }
    const transaction: Record<string, unknown> = {
      hash: h('77'),
      from: d.owner,
      to: factory,
      input: prepared.unsignedTransaction.data,
      value: 0n,
      chainId: 56,
      blockNumber: 100n,
      blockHash: snapshot.block.hash,
    }
    const receipt: Record<string, unknown> = {
      transactionHash: h('77'),
      blockNumber: 100n,
      blockHash: snapshot.block.hash,
      status: 'success',
    }
    const reader: StrategySetupReader = {
      ...d.reader,
      getBytecode: vi.fn(async (input) =>
        input.address === STRATEGY_EXPIRY_ENFORCER.address ? '0x6006' : d.reader.getBytecode(input),
      ),
      getChainId: f.reader.getChainId,
      getBlock: f.reader.getBlock,
      getBalance: vi.fn(async () => chain.native),
      getTransaction: vi.fn(async () => transaction),
      getTransactionReceipt: vi.fn(async () => receipt),
      readContract: vi.fn(async (request) => {
        if (request.functionName === 'owner') return chain.owner
        if (request.functionName === 'DELEGATION_MANAGER') return snapshot.manager
        if (request.functionName === 'EXPIRY_ENFORCER') return STRATEGY_EXPIRY_ENFORCER.address
        if (request.functionName === 'epochOf') return chain.epoch
        if (request.functionName === 'isDisabled') return chain.disabled
        if (request.functionName === 'isValidSignature')
          return chain.valid ? '0x1626ba7e' : '0xffffffff'
        if (
          request.functionName === 'getDelegationDigest' ||
          request.functionName === 'getDelegationHash'
        ) {
          const raw = request.args?.[0] as SignedDelegation
          const data = delegationMessage(raw)
          return request.functionName === 'getDelegationDigest'
            ? hashTypedData({
                domain: delegationDomain(56, snapshot.manager),
                types: DELEGATION_TYPES,
                primaryType: 'Delegation',
                message: data,
              })
            : hashStruct({ types: DELEGATION_TYPES, primaryType: 'Delegation', data })
        }
        return f.reader.readContract(request)
      }),
    }
    const config = { store, strategies, deployments: d.config, executor, reader, now: () => now }
    const service = new StrategySetupService(config),
      body = { input, gasLimitWei: '100000000000000' },
      key = randomUUID()
    const create = () => service.prepare(d.owner, body, key)
    const deploy = async () => {
      const view = await create(),
        action = view.actions[0]
      if (!action) throw new Error('Missing deployment action')
      await service.submitAction(d.owner, view.id, action.id, { transactionHash: h('77') })
      return service.finalizeAction(d.owner, view.id, action.id)
    }
    const sign = async () => {
      const view = await deploy()
      const review = await service.prepareAuthorization(d.owner, view.id)
      const signed = await service.fileAuthorization(d.owner, view.id, { signature })
      return { view: signed, review }
    }
    return {
      d,
      f,
      owner: d.owner,
      other,
      service,
      config,
      body,
      key,
      create,
      deploy,
      sign,
      prepared,
      snapshot,
      chain,
      reader,
      transaction,
      receipt,
    }
  }
  it('creates one inert draft/action under concurrent retry, with no authorization/job/watch', async () => {
    const f = await fixture(),
      views = await Promise.all([f.create(), f.create(), f.create()])
    expect(new Set(views.map((v) => v.id)).size).toBe(1)
    expect((await sql`SELECT count(*)::int AS n FROM strategy_setups`)[0]?.n).toBe(1)
    expect((await sql`SELECT count(*)::int AS n FROM strategy_setup_actions`)[0]?.n).toBe(1)
    expect((await sql`SELECT count(*)::int AS n FROM authorizations`)[0]?.n).toBe(0)
    expect((await sql`SELECT count(*)::int AS n FROM jobs`)[0]?.n).toBe(0)
  })
  it('rejects changed input for the same setup retry key and isolates owners', async () => {
    const f = await fixture(),
      view = await f.create()
    await expect(
      f.service.prepare(f.owner, { ...f.body, gasLimitWei: '1' }, f.key),
    ).rejects.toThrow('different reviewed limits')
    await expect(f.service.get(other, view.id)).rejects.toMatchObject({ statusCode: 404 })
    expect(await f.service.list(other)).toEqual({ setups: [] })
    const action = view.actions[0]
    if (!action) throw new Error('Missing action')
    await expect(
      f.service.submitAction(other, view.id, action.id, { transactionHash: h('77') }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
  it('rejects an unrepresentable service expiry before RPC or durable creation', async () => {
    const f = await fixture()
    vi.mocked(prepareStrategyDeployment).mockClear()
    await expect(
      f.service.prepare(
        f.owner,
        {
          ...f.body,
          input: {
            ...f.body.input,
            common: { ...f.body.input.common, expiresAt: '8640000000001' },
          },
        },
        f.key,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prepareStrategyDeployment).not.toHaveBeenCalled()
    expect((await sql`SELECT count(*)::int AS n FROM strategy_setups`)[0]?.n).toBe(0)
  })
  it('fails closed without reviewed deployments but keeps the configured first-party service identity visible', async () => {
    const f = await fixture(),
      agents = { yield: { agentId: '315944', registry: other, chainId: 56 as const } }
    const service = new StrategySetupService({ ...f.config, deployments: null, agents })
    expect(await service.publicConfig()).toMatchObject({ available: false, chainId: 56, agents })
    await expect(service.prepare(f.owner, f.body, f.key)).rejects.toMatchObject({ statusCode: 503 })
    expect((await sql`SELECT count(*)::int AS n FROM strategy_setups`)[0]?.n).toBe(0)
  })
  it('recovers the same draft action after the initial response gap without creating another setup', async () => {
    const f = await fixture()
    const original = store.prepareAction.bind(store),
      spy = vi
        .spyOn(store, 'prepareAction')
        .mockRejectedValueOnce(new Error('lost pre-action connection'))
    await expect(f.create()).rejects.toThrow()
    spy.mockImplementation(original)
    const restored = await f.create()
    expect(restored.actions).toHaveLength(1)
    expect((await sql`SELECT count(*)::int AS n FROM strategy_setups`)[0]?.n).toBe(1)
  })
  it('persists one immutable hash and refuses replacement or another pending wallet action', async () => {
    const f = await fixture(),
      view = await f.create(),
      action = view.actions[0]
    if (!action) throw new Error('Missing action')
    await f.service.submitAction(f.owner, view.id, action.id, { transactionHash: h('77') })
    await expect(
      f.service.submitAction(f.owner, view.id, action.id, { transactionHash: h('88') }),
    ).rejects.toThrow('cannot be replaced')
    await expect(
      store.prepareAction(view.id, f.owner, h('89'), {
        kind: 'resume',
        transaction: action.transaction,
        review: { summary: 'fixture' },
      }),
    ).rejects.toThrow('existing wallet request')
    expect((await store.action(view.id, f.owner, action.id)).transactionHash).toBe(h('77'))
  })
  it('files exactly one signed authorization/job/inert watch atomically under retry', async () => {
    const f = await fixture(),
      view = await f.deploy(),
      review = await f.service.prepareAuthorization(f.owner, view.id)
    const result = await Promise.all([
      f.service.fileAuthorization(f.owner, view.id, { signature }),
      f.service.fileAuthorization(f.owner, view.id, { signature }),
    ])
    expect(result[0]?.authorization?.digest).toBe(review.digest)
    for (const table of ['authorizations', 'jobs', 'strategy_watches'])
      expect((await sql`SELECT count(*)::int AS n FROM ${sql(table)}`)[0]?.n).toBe(1)
    expect(result[0]?.status).toBe('PAUSED')
    const auth = result[0]?.authorization
    if (!auth) throw new Error('Missing authority')
    await expect(
      sql`INSERT INTO execution_attempts(id,authorization_id,job_id,chain_id,executor_address,state) VALUES(${randomUUID()},${auth.id},${auth.jobId},56,${executor},'PREPARING')`,
    ).rejects.toThrow('legacy execution')
    expect(JSON.stringify(result[0])).not.toContain(signature)
  })
  it('rolls back authorization and job if inert-watch registration fails, then retries the same review', async () => {
    const f = await fixture(),
      view = await f.deploy()
    await f.service.prepareAuthorization(f.owner, view.id)
    const original = strategies.registerPaused.bind(strategies),
      spy = vi
        .spyOn(strategies, 'registerPaused')
        .mockRejectedValueOnce(new Error('test atomic failure'))
    await expect(f.service.fileAuthorization(f.owner, view.id, { signature })).rejects.toThrow(
      'atomic failure',
    )
    expect((await sql`SELECT count(*)::int AS n FROM authorizations`)[0]?.n).toBe(0)
    expect((await sql`SELECT count(*)::int AS n FROM jobs`)[0]?.n).toBe(0)
    spy.mockImplementation(original)
    expect(
      (await f.service.fileAuthorization(f.owner, view.id, { signature })).authorization?.signedAt,
    ).toBeTruthy()
  })
  it.each(['signature', 'epoch', 'revocation', 'owner'] as const)(
    'rejects changed %s before filing any authority',
    async (mode) => {
      const f = await fixture(),
        view = await f.deploy()
      await f.service.prepareAuthorization(f.owner, view.id)
      if (mode === 'signature') f.chain.valid = false
      if (mode === 'epoch') f.chain.epoch = 1n
      if (mode === 'revocation') f.chain.disabled = true
      if (mode === 'owner') f.chain.owner = other
      await expect(f.service.fileAuthorization(f.owner, view.id, { signature })).rejects.toThrow()
      expect((await sql`SELECT count(*)::int AS n FROM authorizations`)[0]?.n).toBe(0)
    },
  )
  it('requires explicit onchain resume, exact-config live scheduler and gas before starting, while service pause survives configuration loss', async () => {
    const f = await fixture(),
      { view } = await f.sign()
    await expect(f.service.start(f.owner, view.id)).rejects.toThrow()
    f.f.setVault('paused', false)
    f.f.setVault('operationNonce', 8n)
    await expect(f.service.start(f.owner, view.id)).rejects.toThrow('scheduler')
    const runner = new PostgresStrategyRunnerStore(sql)
    await runner.heartbeat({
      instanceId: randomUUID(),
      configurationHash: strategyDeploymentConfigDigest(f.d.config),
      ready: true,
      reason: 'Local fixture ready.',
    })
    f.chain.native = 0n
    await expect(f.service.start(f.owner, view.id)).rejects.toThrow('gas')
    f.chain.native = 10n ** 18n
    expect((await f.service.start(f.owner, view.id)).status).toBe('ACTIVE')
    const stopped = new StrategySetupService({ ...f.config, deployments: null })
    const paused = await stopped.pause(f.owner, view.id)
    expect(paused.status).toBe('PAUSED')
    expect(paused.readiness.ready).toBe(false)
  })
  it('enforces immutable SQL setup identities and reviewed wallet intent amounts', async () => {
    const f = await fixture(),
      view = await f.deploy()
    await expect(
      sql`UPDATE strategy_setups SET owner=${other} WHERE id=${view.id}`,
    ).rejects.toThrow('immutable')
    const tx = {
      chainId: 56 as const,
      from: f.owner,
      to: f.snapshot.binding.vault,
      data: '0x1234' as Hex,
      value: '0' as const,
    }
    const action = await store.prepareAction(
      view.id,
      f.owner,
      h('90'),
      { kind: 'resume', transaction: tx, review: { summary: 'test' } },
      { key: 'intent', digest: setupDigest({ assets: '10' }) },
    )
    await store.submitAction(view.id, f.owner, action.id, h('91'))
    await store.finishAction({
      id: view.id,
      owner: f.owner,
      actionId: action.id,
      hash: h('91'),
      status: 'REVERTED',
      block: { number: '100', hash: h('92') },
    })
    await expect(
      store.prepareAction(
        view.id,
        f.owner,
        h('93'),
        { kind: 'resume', transaction: tx, review: { summary: 'test' } },
        { key: 'intent', digest: setupDigest({ assets: '11' }) },
      ),
    ).rejects.toThrow('different reviewed amounts')
    await expect(
      sql`UPDATE strategy_setup_actions SET transaction_data=${sql.json(setupJSON({ ...tx, data: '0x123456' }))} WHERE id=${action.id}`,
    ).rejects.toThrow('immutable')
  })
  it('retains the open owner request after more than 100 historical steps', async () => {
    const f = await fixture(),
      view = await f.deploy(),
      transaction = f.prepared.unsignedTransaction
    await sql`INSERT INTO strategy_setup_actions(id,setup_id,request_digest,kind,transaction_data,review,state,transaction_hash,receipt_block,receipt_hash,created_at)
      SELECT gen_random_uuid(),${view.id},'0x'||lpad(to_hex(i+1000),64,'0'),'resume',${sql.json(setupJSON(transaction))},'{}'::jsonb,'FINALIZED','0x'||lpad(to_hex(i+2000),64,'0'),100,${h('92')},now()+i*interval '1 second' FROM generate_series(1,101) i`
    const pending = await store.prepareAction(view.id, f.owner, h('ab'), {
      kind: 'pause',
      transaction,
      review: { summary: 'Only this pending action must remain visible.' },
    })
    const actions = await store.actions(view.id, f.owner)
    expect(actions).toHaveLength(100)
    expect(actions.at(-1)?.id).toBe(pending.id)
    expect((await f.service.get(f.owner, view.id)).readiness.reasons).toContain(
      'Resolve the pending owner wallet request first.',
    )
  })
  it('rejects an owner wallet action inserted after readiness but before atomic activation', async () => {
    const f = await fixture(),
      { view } = await f.sign()
    f.f.setVault('paused', false)
    f.f.setVault('operationNonce', 8n)
    await new PostgresStrategyRunnerStore(sql).heartbeat({
      instanceId: randomUUID(),
      configurationHash: strategyDeploymentConfigDigest(f.d.config),
      ready: true,
      reason: 'Local fixture ready.',
    })
    const original = store.transaction.bind(store)
    vi.spyOn(store, 'transaction').mockImplementationOnce(async (id, owner, work) => {
      await original(id, owner, async (tx) => {
        await tx`INSERT INTO strategy_setup_actions(id,setup_id,request_digest,kind,transaction_data,review) VALUES(${randomUUID()},${id},${h('ab')},'pause',${tx.json(setupJSON(f.prepared.unsignedTransaction))},'{}'::jsonb)`
      })
      return original(id, owner, work)
    })
    await expect(f.service.start(f.owner, view.id)).rejects.toThrow('pending owner wallet request')
    expect((await f.service.get(f.owner, view.id)).status).toBe('PAUSED')
  })
  it('rolls back activation and its job event if the enclosing setup transaction fails', async () => {
    const f = await fixture(),
      { view } = await f.sign()
    f.f.setVault('paused', false)
    f.f.setVault('operationNonce', 8n)
    await new PostgresStrategyRunnerStore(sql).heartbeat({
      instanceId: randomUUID(),
      configurationHash: strategyDeploymentConfigDigest(f.d.config),
      ready: true,
      reason: 'Local fixture ready.',
    })
    const original = strategies.syncSnapshot.bind(strategies)
    vi.spyOn(strategies, 'syncSnapshot').mockImplementationOnce(async (input, tx) => {
      expect(tx).toBeDefined()
      await original(input, tx)
      throw new Error('test enclosing transaction rollback')
    })
    await expect(f.service.start(f.owner, view.id)).rejects.toThrow(
      'enclosing transaction rollback',
    )
    expect((await f.service.get(f.owner, view.id)).status).toBe('PAUSED')
    expect(
      (
        await sql`SELECT count(*)::int AS n FROM job_events WHERE detail='Strategy started with the owner-approved limits.'`
      )[0]?.n,
    ).toBe(0)
  })
})
