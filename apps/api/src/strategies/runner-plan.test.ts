import { ROOT_AUTHORITY } from '@aiki/contracts'
import type { Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeStrategyBindingTerms,
  encodeStrategyExpiryTerms,
  STRATEGY_EXPIRY_ENFORCER,
} from './grant.js'
import { planStrategyPass, type StrategyPlanReader } from './runner-plan.js'
import { strategyJSON } from './runner-policy.js'
import { isVerifiedStrategySimulation } from './simulation.js'
import { snapshotFixture } from './snapshot.test-support.js'
import { yieldPlannerFixture } from './yield-planner.test-support.js'

const mocks = vi.hoisted(() => ({ readYield: vi.fn() }))
vi.mock('./yield/snapshot.js', async (original) => ({
  ...(await original<object>()),
  readYieldSnapshot: mocks.readYield,
}))
vi.mock('../config/deployments/bsc-mainnet.json', async (original) => {
  const data = await original<{ default: object }>(),
    { keccak256 } = await import('viem')
  return { default: { ...data.default, managerCodeHash: keccak256('0x6005') } }
})
beforeEach(() => vi.resetAllMocks())
async function request(seconds = 0) {
  const { snapshot: evidence, policy } = yieldPlannerFixture()
  evidence.block.timestamp += seconds
  evidence.block.number += BigInt(seconds)
  const sf = snapshotFixture('yield', {
    timestamp: BigInt(evidence.block.timestamp),
    blockNumber: evidence.block.number,
    blockHash: evidence.block.hash,
    expiresAt: BigInt(evidence.expiresAt),
    nonce: evidence.nonce,
  })
  sf.setVault('limits', Object.values(evidence.limits))
  const verified = await sf.run()
  if (verified.status !== 'verified') throw new Error('Invalid generic snapshot fixture')
  const snapshot = verified.snapshot
  for (const obj of [evidence, policy])
    Object.assign(obj, {
      vault: snapshot.binding.vault,
      controller: snapshot.binding.controller,
      policyHash: snapshot.binding.policyHash,
    })
  for (const venue of Object.values(evidence.venues))
    Object.assign(venue, { blockNumber: evidence.block.number, blockHash: evidence.block.hash })
  Object.assign(evidence.nativePrice ?? {}, {
    blockNumber: evidence.block.number,
    blockHash: evidence.block.hash,
    updatedAt: evidence.block.timestamp,
  })
  const executor = `0x${'66'.repeat(20)}` as Hex
  const delegation = {
    delegate: executor,
    delegator: snapshot.binding.controller,
    authority: ROOT_AUTHORITY,
    caveats: [
      {
        enforcer: STRATEGY_EXPIRY_ENFORCER.address,
        terms: encodeStrategyExpiryTerms(snapshot.expiresAt),
        args: '0x' as Hex,
      },
      {
        enforcer: snapshot.bindingEnforcer.address,
        terms: encodeStrategyBindingTerms(snapshot.binding),
        args: '0x' as Hex,
      },
    ],
    salt: 1n,
    epoch: 0n,
    signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}11b` as Hex,
  }
  const calls = {
    call: vi.fn(async () => ({ data: '0x' as Hex })),
    estimateGas: vi.fn(async () => 100000n),
    getGasPrice: vi.fn(async () => 50000000n),
  }
  const reader = { ...sf.reader, ...calls } as unknown as StrategyPlanReader
  mocks.readYield.mockResolvedValue(evidence)
  const input: Parameters<typeof planStrategyPass>[0] = {
    snapshot,
    policy: { version: 1, kind: 'yield', intervalSeconds: 60, planner: policy },
    delegation,
    executor,
    reader,
    plannerState: {},
    gasLimitWei: 10n ** 14n,
    now: () => evidence.block.timestamp,
    yieldConfig: {
      vault: evidence.vault,
      controller: evidence.controller,
      policyHash: evidence.policyHash,
      factory: { address: snapshot.factory.address, runtimeHash: snapshot.factory.runtimeCodeHash },
      multicallRuntimeHash: snapshot.binding.runtimeCodeHash,
      venusImplementation: { address: executor, runtimeHash: snapshot.binding.runtimeCodeHash },
      aaveImplementation: { address: executor, runtimeHash: snapshot.binding.runtimeCodeHash },
      aaveReceiptImplementation: {
        address: executor,
        runtimeHash: snapshot.binding.runtimeCodeHash,
      },
    },
  }
  return { input, evidence, policy, snapshot, calls }
}
describe('runner connects yield quotes to the reviewed planner', () => {
  it('quotes every useful move through the full manager, then returns only an opaque matching quote', async () => {
    const t = await request(),
      result = await planStrategyPass(t.input)
    expect(result.act).toBe(true)
    if (!result.act) throw new Error(result.reason)
    expect(isVerifiedStrategySimulation(result.quote)).toBe(true)
    expect(result.operation).toMatchObject({
      kind: 'yield',
      expectedNonce: t.snapshot.nonce,
      binding: t.snapshot.binding,
    })
    expect(result.gasBudgetWei).toBe(6000000000000n)
    expect(t.calls.call.mock.calls.length).toBeGreaterThan(1)
    expect(t.calls.call.mock.calls.length).toBeLessThanOrEqual(24)
    expect(t.calls.estimateGas.mock.calls.length).toBe(t.calls.call.mock.calls.length)
    expect(t.evidence.executionQuotes.every((q) => q.unwindGasUnits >= 2000000n)).toBe(true)
    expect(mocks.readYield).toHaveBeenCalledWith(
      t.input.reader,
      t.input.yieldConfig,
      expect.anything(),
      t.snapshot,
    )
    for (const [call] of t.calls.call.mock.calls as unknown as [
      { to: Hex; value: bigint; blockNumber: bigint },
    ][]) {
      expect(call).toMatchObject({
        to: t.snapshot.manager,
        value: 0n,
        blockNumber: t.snapshot.block.number,
      })
    }
  })
  it('does not substitute a lower-ranked move if any useful complete quote fails', async () => {
    const t = await request()
    t.calls.call.mockRejectedValueOnce(new Error('simulated revert'))
    const result = await planStrategyPass(t.input)
    expect(result).toMatchObject({ act: false, code: 'QUOTE_REQUIRED' })
  })
  it('retains independent observations across JSON storage before selecting an action', async () => {
    const t = await request()
    t.policy.requiredObservations = 2
    t.policy.minObservationSeconds = 60
    t.policy.maxObservationGapSeconds = 900
    const first = await planStrategyPass(t.input)
    expect(first).toMatchObject({ act: false, code: 'HYSTERESIS' })
    const next = await request(60)
    next.policy.requiredObservations = 2
    next.policy.minObservationSeconds = 60
    next.policy.maxObservationGapSeconds = 900
    next.input.plannerState = JSON.parse(strategyJSON(first.nextState))
    const second = await planStrategyPass(next.input)
    expect(second.act).toBe(true)
  })
  it('uses the same fixed nonce and short deadline for every candidate, never optimistic inventory', async () => {
    const t = await request(),
      before = t.snapshot.state
    await planStrategyPass(t.input)
    expect(
      t.evidence.executionQuotes.every(
        (q) =>
          q.nonce === t.snapshot.nonce && q.deadline === Number(t.snapshot.block.timestamp) + 90,
      ),
    ).toBe(true)
    expect(t.snapshot.state).toBe(before)
  })
  it('stops quoting when the custody snapshot ages and never upgrades that stale quote to an action', async () => {
    const t = await request()
    let reads = 0
    t.input.now = () => t.evidence.block.timestamp + (reads++ === 0 ? 0 : 26)
    const result = await planStrategyPass(t.input)
    expect(result).toMatchObject({ act: false, code: 'STALE_SNAPSHOT' })
    expect(t.calls.call).not.toHaveBeenCalled()
  })
  it('refuses insufficient native gas even when projected USDT benefit is positive', async () => {
    const t = await request()
    t.input.gasLimitWei = 1n
    expect(await planStrategyPass(t.input)).toMatchObject({ act: false, code: 'GAS_LIMIT' })
  })
  it('requires current price and known venue models before any simulation', async () => {
    const t = await request()
    t.evidence.nativePrice = null
    expect(await planStrategyPass(t.input)).toMatchObject({ act: false, code: 'PRICE_UNAVAILABLE' })
    expect(t.calls.call).not.toHaveBeenCalled()
  })
  it('cannot combine accounting at a different nonce with custody', async () => {
    const t = await request()
    t.evidence.nonce++
    expect(await planStrategyPass(t.input)).toMatchObject({ act: false, code: 'STATE_CHANGED' })
    expect(t.calls.call).not.toHaveBeenCalled()
  })
  it('refuses missing reviewed yield config', async () => {
    const t = await request()
    delete t.input.yieldConfig
    expect(await planStrategyPass(t.input)).toMatchObject({
      act: false,
      code: 'CONFIG_UNAVAILABLE',
    })
    expect(mocks.readYield).not.toHaveBeenCalled()
  })
})
