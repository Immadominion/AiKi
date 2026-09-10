import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deploymentFixture } from './deployment.test-support.js'
import { strategyDeploymentConfigDigest } from './deployment-config.js'
import { fixture as receiptFixture, yieldOp } from './receipt.test-support.js'
import { runStrategySweep, type StrategyRunnerInput, type StrategyRunnerReader } from './runner.js'
import { createStrategyRunnerPolicy, strategyJSON } from './runner-policy.js'
import type { StrategyRunnerClaim } from './runner-store.js'
import { snapshotFixture } from './snapshot.test-support.js'

const mock = vi.hoisted(() => ({
  verifyConfig: vi.fn(),
  verifySnapshot: vi.fn(),
  verifyMandate: vi.fn(),
  plan: vi.fn(),
  recover: vi.fn(),
}))
vi.mock('./deployment-verification.js', async (original) => ({
  ...(await original<object>()),
  verifyStrategyDeploymentConfiguration: mock.verifyConfig,
}))
vi.mock('./snapshot.js', async (original) => ({
  ...(await original<object>()),
  verifyStrategySnapshot: mock.verifySnapshot,
}))
vi.mock('./setup-readiness.js', async (original) => ({
  ...(await original<object>()),
  verifyStrategyMandate: mock.verifyMandate,
}))
vi.mock('./runner-plan.js', async (original) => ({
  ...(await original<object>()),
  planStrategyPass: mock.plan,
}))
vi.mock('./recovery.js', () => ({ recoverStrategyOperation: mock.recover }))
vi.mock('../config/deployments/bsc-mainnet.json', async (original) => {
  const data = await original<{ default: object }>(),
    { keccak256 } = await import('viem')
  return { default: { ...data.default, managerCodeHash: keccak256('0x6005') } }
})
beforeEach(() => vi.resetAllMocks())
async function harness() {
  const sf = snapshotFixture('yield'),
    actual = await vi.importActual<typeof import('./snapshot.js')>('./snapshot.js')
  const proof = await actual.verifyStrategySnapshot(sf.target, sf.reader)
  if (proof.status !== 'verified') throw new Error('Invalid snapshot fixture')
  const snapshot = proof.snapshot,
    { config } = deploymentFixture(),
    f = receiptFixture(yieldOp)
  const executor = f.target.executor
  const claim: StrategyRunnerClaim = {
    watchId: randomUUID(),
    leaseId: randomUUID(),
    revision: '0',
    owner: snapshot.owner,
    authorizationId: randomUUID(),
    authorizationStatus: 'active',
    authorizationExpiresAt: new Date(Number(snapshot.expiresAt) * 1000).toISOString(),
    jobStatus: 'AUTHORIZED',
    binding: snapshot.binding,
    manager: snapshot.manager,
    executor,
    bindingEnforcer: config.bindingEnforcer.address,
    gasLimitWei: 10n ** 14n,
    policy: JSON.parse(strategyJSON(createStrategyRunnerPolicy(snapshot, 10n ** 14n))),
    plannerState: {},
    delegation: { ...f.delegation, salt: '1', epoch: '0' },
  }
  const scheduler = {
    heartbeat: vi.fn(async () => {}),
    claimDue: vi.fn().mockResolvedValueOnce([claim]).mockResolvedValue([]),
    listPendingAttemptIds: vi.fn(async () => [] as string[]),
    savePlannerState: vi.fn(async () => '2' as string | null),
    finishPass: vi.fn(async () => true),
  }
  const store = {
    syncSnapshot: vi.fn(async () => ({ status: 'applied' as const, revision: '1', active: true })),
    getPendingAttempt: vi.fn(),
    settle: vi.fn(),
    requireReview: vi.fn(),
  }
  const getBalance = vi.fn(async () => 10n ** 16n)
  const reader = { ...sf.reader, getBalance } as unknown as StrategyRunnerReader
  const execute = vi.fn<NonNullable<StrategyRunnerInput['execute']>>().mockResolvedValue({
    status: 'landed',
    attemptId: randomUUID(),
    transactionHash: f.target.transactionHash,
  })
  mock.verifyConfig.mockResolvedValue({ config, block: snapshot.block })
  mock.verifySnapshot.mockResolvedValue(proof)
  mock.verifyMandate.mockResolvedValue({ ready: true, digest: f.target.envelopeHash })
  mock.plan.mockResolvedValue({
    act: false,
    code: 'COOLDOWN',
    reason: 'Waiting for the next check.',
    nextState: {},
  })
  mock.recover.mockResolvedValue({ status: 'needs_review', attemptId: 'pending' })
  const input: StrategyRunnerInput = {
    scheduler,
    store,
    reader,
    config,
    executor,
    execute,
    now: () => Number(snapshot.block.timestamp),
  }
  const actionable = () =>
    mock.plan.mockResolvedValue({
      act: true,
      operation: f.target.operation,
      quote: { testOnly: true },
      gasBudgetWei: 1_000_000n,
      nextState: { lastObservation: { nonce: 7n } },
    })
  return { input, snapshot, claim, scheduler, store, execute, getBalance, actionable, config }
}
describe('strategy worker orchestration (no wallet or broadcast)', () => {
  it('recovers existing hashes even when new automation is not configured', async () => {
    const t = await harness()
    t.input.config = null
    t.scheduler.listPendingAttemptIds.mockResolvedValue(['existing'])
    mock.recover.mockResolvedValue({ status: 'landed', attemptId: 'existing' })
    expect(await runStrategySweep(t.input)).toMatchObject({ ready: false, recovered: 1, looked: 0 })
    expect(mock.recover).toHaveBeenCalledWith({
      store: t.store,
      reader: t.input.reader,
      attemptId: 'existing',
    })
    expect(t.execute).not.toHaveBeenCalled()
    expect(t.scheduler.claimDue).not.toHaveBeenCalled()
    expect(t.scheduler.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ ready: false }))
  })
  it.each(['executor', 'execute'] as const)('does not start without %s', async (key) => {
    const t = await harness()
    delete t.input[key]
    expect(await runStrategySweep(t.input)).toMatchObject({ ready: false, looked: 0 })
    expect(t.scheduler.claimDue).not.toHaveBeenCalled()
  })
  it('does not advertise an unfunded executor as ready', async () => {
    const t = await harness()
    t.getBalance.mockResolvedValue(0n)
    expect(await runStrategySweep(t.input)).toMatchObject({ ready: false, looked: 0 })
    expect(t.scheduler.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ready: false,
        configurationHash: strategyDeploymentConfigDigest(t.config),
      }),
    )
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('publishes the actual executor identity with every ready heartbeat', async () => {
    const t = await harness()
    expect((await runStrategySweep(t.input)).ready).toBe(true)
    for (const [heartbeat] of t.scheduler.heartbeat.mock.calls as unknown as [
      { ready: boolean; executor?: string },
    ][]) {
      expect(heartbeat).toMatchObject({ ready: true, executor: t.input.executor })
    }
  })
  it('refuses incorrect or unavailable deployment pins before claiming work', async () => {
    const t = await harness()
    mock.verifyConfig.mockRejectedValue(new Error('RPC contains sensitive details'))
    expect(await runStrategySweep(t.input)).toMatchObject({ ready: false, looked: 0 })
    expect(JSON.stringify(t.scheduler.heartbeat.mock.calls)).not.toContain('sensitive')
  })
  it.each([
    { authorizationStatus: 'revoked' },
    { jobStatus: 'COMPLETED' },
    { authorizationExpiresAt: null },
    { authorizationExpiresAt: '2020-01-01T00:00:00.000Z' },
    { executor: '0x1234' },
    { manager: '0x1234' },
    { bindingEnforcer: '0x1234' },
  ])('stops a changed service mandate %j', async (change) => {
    const t = await harness()
    Object.assign(t.claim, change)
    expect(await runStrategySweep(t.input)).toMatchObject({ looked: 1, stopped: 1, acted: 0 })
    expect(t.scheduler.finishPass).toHaveBeenCalledWith(
      expect.objectContaining({ stop: true, code: 'AUTHORITY_CHANGED' }),
    )
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('verifies complete snapshot and current signed mandate even when no trade is needed', async () => {
    const t = await harness()
    expect(await runStrategySweep(t.input)).toMatchObject({
      ready: true,
      looked: 1,
      waiting: 1,
      acted: 0,
    })
    expect(mock.verifyMandate).toHaveBeenCalledWith(
      expect.objectContaining({
        delegation: t.claim.delegation,
        owner: t.claim.owner,
        snapshot: t.snapshot,
      }),
    )
    expect(mock.verifyConfig).toHaveBeenLastCalledWith(t.config, t.input.reader, {
      block: t.snapshot.block,
    })
    expect(t.store.syncSnapshot).toHaveBeenCalledWith({
      watchId: t.claim.watchId,
      expectedRevision: '0',
      snapshot: t.snapshot,
    })
    expect(t.scheduler.savePlannerState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: '1', leaseId: t.claim.leaseId }),
    )
    expect(t.execute).not.toHaveBeenCalled()
  })
  it.each([true, false])(
    'handles a retryable=%s authority refusal without sending',
    async (retryable) => {
      const t = await harness()
      mock.verifyMandate.mockResolvedValue({
        ready: false,
        retryable,
        reason: 'Authority unavailable.',
      })
      await runStrategySweep(t.input)
      expect(t.scheduler.finishPass).toHaveBeenCalledWith(
        expect.objectContaining({ stop: !retryable, code: 'AUTHORITY_UNAVAILABLE' }),
      )
      expect(mock.plan).not.toHaveBeenCalled()
      expect(t.execute).not.toHaveBeenCalled()
    },
  )
  it('does not plan from an incomplete snapshot', async () => {
    const t = await harness()
    mock.verifySnapshot.mockResolvedValue({ status: 'blocked' })
    await runStrategySweep(t.input)
    expect(mock.plan).not.toHaveBeenCalled()
    expect(t.execute).not.toHaveBeenCalled()
    expect(t.scheduler.finishPass).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'STATE_UNAVAILABLE' }),
    )
  })
  it('owner pause or a competing refresh wins before planning', async () => {
    const t = await harness()
    t.store.syncSnapshot.mockResolvedValue({ status: 'applied', revision: '1', active: false })
    await runStrategySweep(t.input)
    expect(mock.plan).not.toHaveBeenCalled()
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('stops if persisted planner settings have been widened', async () => {
    const t = await harness()
    t.claim.policy = { version: 2 }
    await runStrategySweep(t.input)
    expect(t.scheduler.finishPass).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'POLICY_MISMATCH', stop: true }),
    )
    expect(mock.plan).not.toHaveBeenCalled()
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('never sends after losing the exact lease or observation revision', async () => {
    const t = await harness()
    t.actionable()
    t.scheduler.savePlannerState.mockResolvedValue(null)
    await runStrategySweep(t.input)
    expect(t.execute).not.toHaveBeenCalled()
    expect(t.scheduler.finishPass).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'STATE_CHANGED' }),
    )
  })
  it('passes only the newly committed revision and quoted gas ceiling into execution', async () => {
    const t = await harness()
    t.actionable()
    expect(await runStrategySweep(t.input)).toMatchObject({ acted: 1, looked: 1, waiting: 0 })
    expect(t.execute).toHaveBeenCalledOnce()
    expect(t.execute).toHaveBeenCalledWith({
      claim: t.claim,
      expectedRevision: '2',
      plan: expect.objectContaining({ gasBudgetWei: 1_000_000n }),
    })
    expect(t.scheduler.savePlannerState.mock.invocationCallOrder[0]).toBeLessThan(
      t.execute.mock.invocationCallOrder[0] ?? 0,
    )
    expect(t.scheduler.finishPass).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CONFIRMED', stop: false }),
    )
  })
  it('refuses a quoted ceiling above the registered one', async () => {
    const t = await harness()
    t.actionable()
    t.claim.gasLimitWei = 1n
    t.claim.policy = JSON.parse(strategyJSON(createStrategyRunnerPolicy(t.snapshot, 1n)))
    await runStrategySweep(t.input)
    expect(t.execute).not.toHaveBeenCalled()
    expect(t.scheduler.finishPass).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'GAS_UNAVAILABLE' }),
    )
  })
  it.each(['refused', 'reverted', 'needs_review'] as const)(
    'stops after %s, never substitutes another transaction',
    async (status) => {
      const t = await harness()
      t.actionable()
      t.execute.mockResolvedValue({
        status,
        attemptId: randomUUID(),
        transactionHash: `0x${'01'.repeat(32)}`,
      })
      expect(await runStrategySweep(t.input)).toMatchObject({ stopped: 1, acted: 0 })
      expect(t.execute).toHaveBeenCalledOnce()
      expect(t.scheduler.finishPass).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'EXECUTION_REVIEW', stop: true }),
      )
    },
  )
  it('a transport exception is not retried by the orchestration layer', async () => {
    const t = await harness()
    t.actionable()
    t.execute.mockRejectedValue(new Error('secret RPC diagnostics'))
    await runStrategySweep(t.input)
    expect(t.execute).toHaveBeenCalledOnce()
    expect(JSON.stringify(t.scheduler.finishPass.mock.calls)).not.toContain('secret')
  })
  it('renews heartbeat after a waiting pass and bounds workload', async () => {
    const t = await harness()
    t.input.limit = 1
    await runStrategySweep(t.input)
    expect(t.scheduler.claimDue).toHaveBeenCalledTimes(1)
    expect(t.scheduler.heartbeat).toHaveBeenCalledTimes(3)
    await expect(runStrategySweep({ ...t.input, limit: 21 })).rejects.toThrow(
      'between one and twenty',
    )
  })
})
