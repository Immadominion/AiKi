import { describe, expect, it, vi } from 'vitest'
import type { VerifiedGridMarketSnapshot } from './grid/market.js'
import { gasPolicy, gridFixture, NOW, simulationFixture } from './grid/test-support.js'
import { type GridPlannerRequest, planGrid } from './grid-planner.js'
import type { VerifiedStrategySnapshot } from './snapshot.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x6005') } }
})
async function request(f = gridFixture()) {
  const evidence = await f.evidence(),
    simulation = simulationFixture(evidence.snapshot)
  const input: GridPlannerRequest = {
    ...evidence,
    policy: { ...gasPolicy },
    now: () => NOW,
    simulate: simulation.simulate,
  }
  return { f, ...evidence, ...simulation, input }
}

describe('bounded persistent-state Grid planner', () => {
  it('proposes baseline only after owner nonce invalidation, never historical fill', async () => {
    const f = gridFixture(301)
    f.rung(0, { armed: true })
    f.setVault('operationNonce', 8n)
    const t = await request(f),
      result = await planGrid(t.input)
    expect(result).toMatchObject({
      act: true,
      transition: 'baseline',
      expectedInput: 0n,
      operation: {
        kind: 'grid',
        expectedNonce: 8n,
        baseline: true,
        rungIndex: 0,
        before: { armed: true, inventory0: 10n, cycle: 0n },
      },
    })
    expect(t.simulate).toHaveBeenCalledTimes(1)
    expect(t.snapshot.state).toMatchObject({ initialized: true, observationNonce: 7n })
  })
  it('first activation does not fill an already-crossed rung', async () => {
    const f = gridFixture(-201)
    f.setVault('initialized', false)
    expect(await planGrid((await request(f)).input)).toMatchObject({
      act: true,
      transition: 'baseline',
      expectedInput: 0n,
    })
  })
  it('persists an actual hysteresis-qualified arming transition without fabricating a fill', async () => {
    const t = await request(gridFixture(290)),
      result = await planGrid(t.input)
    expect(result).toMatchObject({
      act: true,
      transition: 'arm',
      expectedInput: 0n,
      operation: { rungIndex: 0, baseline: false },
    })
    expect(t.snapshot.state).toMatchObject({
      rungs: [{ state: { armed: false } }, { state: { armed: true } }],
    })
  })
  it('does not buy observations for unchanged price or unqualified arming', async () => {
    for (const spot of [290, 291]) {
      const f = gridFixture(spot)
      if (spot === 290) f.rung(0, { armed: true })
      const t = await request(f)
      expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'NO_TRANSITION' })
      expect(t.simulate).not.toHaveBeenCalled()
    }
  })
  it('chooses a funded armed sell crossing and binds all pre-rung state', async () => {
    const f = gridFixture(301)
    f.rung(0, { armed: true })
    const t = await request(f),
      result = await planGrid(t.input)
    expect(result).toMatchObject({
      act: true,
      transition: 'fill',
      expectedInput: 10n,
      bufferedGasCostWei: 240000n,
      operation: {
        rungIndex: 0,
        baseline: false,
        before: { inventory0: 10n, inventory1: 30n, cycle: 0n, nextSell: true, armed: true },
      },
    })
    if (!result.act) throw new Error('Expected fill')
    expect(Object.isFrozen(result.operation)).toBe(true)
    expect(Object.isFrozen(result.operation.before)).toBe(true)
    expect(t.reader.call).toHaveBeenCalledTimes(1)
    expect(t.reader.estimateGas).toHaveBeenCalledTimes(1)
    expect(t.reader.call.mock.calls).toEqual(t.reader.estimateGas.mock.calls)
  })
  it('buys only the already-armed funded rung and prioritizes fill over arming another', async () => {
    const t = await request(gridFixture(-201))
    expect(await planGrid(t.input)).toMatchObject({
      act: true,
      transition: 'fill',
      expectedInput: 10n,
      operation: { rungIndex: 1, before: { nextSell: false } },
    })
    expect(t.simulate).toHaveBeenCalledTimes(1)
  })
  it('selects the lowest triggered index deterministically and emits only one operation', async () => {
    const f = gridFixture(450)
    f.rung(0, { armed: true })
    f.rung(1, { armed: true, nextSell: true })
    const t = await request(f)
    expect(await planGrid(t.input)).toMatchObject({
      act: true,
      transition: 'fill',
      operation: { rungIndex: 0 },
    })
    expect(t.simulate).toHaveBeenCalledTimes(1)
  })
  it('does not trade at exact sqrt boundary equality', async () => {
    const f = gridFixture(300)
    f.rung(0, { armed: true })
    const t = await request(f)
    expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'NO_TRANSITION' })
    expect(t.simulate).not.toHaveBeenCalled()
  })
  it('does not bootstrap unfunded rungs or turn donations into inventory', async () => {
    const f = gridFixture()
    for (const i of [0, 1]) f.rung(i, { inventory0: 0n, inventory1: 0n })
    f.setVault('allocated0', 0n)
    f.setVault('allocated1', 0n)
    f.setVault('initialized', false)
    const t = await request(f)
    expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'NO_INVENTORY' })
    expect(t.simulate).not.toHaveBeenCalled()
  })
  it('cannot replenish turnover through observations or borrow the opposite-side inventory', async () => {
    const f = gridFixture()
    f.setVault('turnover0', 2000n)
    f.setVault('turnover1', 2000n)
    const t = await request(f)
    expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'NO_INVENTORY' })
    expect(t.simulate).not.toHaveBeenCalled()
  })
  it('waits outside immutable bounds without regridding or paying for maintenance', async () => {
    for (const tick of [-1001, 1000]) {
      const t = await request(gridFixture(tick))
      expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'OUTSIDE_GRID' })
      expect(t.simulate).not.toHaveBeenCalled()
    }
  })
  it.each(['pause', 'expiry', 'cooldown', 'pending', 'stale', 'future'])(
    'blocks %s before simulation',
    async (mode) => {
      const f = gridFixture()
      if (mode === 'pause') f.setVault('paused', true)
      if (mode === 'expiry') f.setVault('expiresAt', BigInt(NOW))
      if (mode === 'cooldown') f.setVault('lastExecutionAt', BigInt(NOW - 59))
      const t = await request(f)
      if (mode === 'pending') t.input.pendingNonce = 1n
      if (mode === 'stale') t.input.now = () => NOW + 121
      if (mode === 'future') t.input.now = () => NOW - 1
      const code = {
        pause: 'PAUSED',
        expiry: 'EXPIRED',
        cooldown: 'COOLDOWN',
        pending: 'PENDING_EXECUTION',
        stale: 'STALE_SNAPSHOT',
        future: 'STALE_SNAPSHOT',
      }[mode]
      expect(await planGrid(t.input)).toMatchObject({ act: false, code })
      expect(t.simulate).not.toHaveBeenCalled()
    },
  )
  it('rejects forged/copied snapshot or market evidence', async () => {
    const t = await request()
    expect(
      await planGrid({ ...t.input, snapshot: { ...t.snapshot } as VerifiedStrategySnapshot }),
    ).toMatchObject({ act: false, code: 'UNVERIFIED_STATE' })
    expect(
      await planGrid({ ...t.input, market: { ...t.market } as VerifiedGridMarketSnapshot }),
    ).toMatchObject({ act: false, code: 'UNVERIFIED_STATE' })
    expect(t.simulate).not.toHaveBeenCalled()
  })
  it('caps deadline by snapshot execution time, configured TTL and immutable expiry', async () => {
    const t = await request()
    t.input.now = () => NOW + 80
    t.input.policy.deadlineSeconds = 120
    expect(await planGrid(t.input)).toMatchObject({
      act: true,
      operation: { deadline: BigInt(NOW + 120) },
    })
    const f = gridFixture()
    f.setVault('expiresAt', BigInt(NOW + 20))
    expect(await planGrid((await request(f)).input)).toMatchObject({
      act: true,
      operation: { deadline: BigInt(NOW + 20) },
    })
  })
  it('does not claim ready after simulation consumed the deadline or freshness window', async () => {
    const t = await request()
    let calls = 0
    t.input.now = () => NOW + (calls++ === 0 ? 0 : 61)
    expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'STALE_SNAPSHOT' })
  })
  it.each(['units', 'price', 'total'] as const)('enforces explicit %s gas cap', async (mode) => {
    const t = await request()
    if (mode === 'units') t.input.policy.maxGasUnits = 99999n
    if (mode === 'price') t.input.policy.maxGasPriceWei = 1n
    if (mode === 'total') t.input.policy.maxGasCostWei = 239999n
    expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'GAS_LIMIT' })
  })
  it('rejects blocked, throwing, copied and mismatched full-manager quotes', async () => {
    const t = await request()
    expect(
      await planGrid({
        ...t.input,
        simulate: async () => ({ status: 'blocked', reason: 'fixture' }),
      }),
    ).toMatchObject({ act: false, code: 'SIMULATION_REQUIRED' })
    expect(
      await planGrid({
        ...t.input,
        simulate: async () => {
          throw new Error('private fixture')
        },
      }),
    ).toMatchObject({ act: false, code: 'INVALID_INPUT' })
    expect(
      await planGrid({ ...t.input, simulate: async (op) => ({ ...(await t.simulate(op)) }) }),
    ).toMatchObject({ act: false, code: 'SIMULATION_REQUIRED' })
    expect(
      await planGrid({ ...t.input, simulate: (op) => t.simulate({ ...op, rungIndex: 1 }) }),
    ).toMatchObject({ act: false, code: 'SIMULATION_REQUIRED' })
  })
  it('does not optimistically persist arming, consume a nonce or authorize a repeated unresolved pass', async () => {
    const t = await request(),
      before = t.snapshot.nonce
    const first = await planGrid(t.input)
    expect(first.act).toBe(true)
    expect(t.snapshot.nonce).toBe(before)
    expect(t.snapshot.state).toMatchObject({
      rungs: [{ state: { armed: false } }, { state: { armed: true } }],
    })
    expect(await planGrid({ ...t.input, pendingNonce: before })).toMatchObject({
      act: false,
      code: 'PENDING_EXECUTION',
    })
  })
  it('cannot use opposite-phase inventory to arm or fund the next trade', async () => {
    const f = gridFixture()
    f.rung(0, { inventory0: 0n })
    f.rung(1, { inventory1: 0n })
    f.setVault('allocated0', 20n)
    f.setVault('allocated1', 30n)
    const t = await request(f)
    expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'NO_INVENTORY' })
    expect(t.simulate).not.toHaveBeenCalled()
  })
  it('refuses a cycle-overflow fill and does not spend gas arming it', async () => {
    const f = gridFixture()
    f.rung(0, { nextSell: false, cycle: (1n << 64n) - 1n })
    f.rung(1, { inventory1: 0n })
    f.setVault('allocated1', 30n)
    const t = await request(f)
    expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'NO_INVENTORY' })
    expect(t.simulate).not.toHaveBeenCalled()
  })
  it('skips simulation when all same-block deadline allowance is already spent', async () => {
    const t = await request()
    t.input.now = () => NOW + 120
    expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'STALE_SNAPSHOT' })
    expect(t.simulate).not.toHaveBeenCalled()
  })
  it('rejects a genuine quote issued for another finalized block', async () => {
    const t = await request()
    const other = gridFixture()
    other.finalized.number = 101n
    other.canonical.number = 101n
    const simulator = simulationFixture(await other.snapshot())
    expect(await planGrid({ ...t.input, simulate: simulator.simulate })).toMatchObject({
      act: false,
      code: 'SIMULATION_REQUIRED',
    })
  })
  it.each(['maxGasCostWei', 'maxGasUnits', 'maxGasPriceWei'] as const)(
    'rejects absent economic budget %s before simulation',
    async (key) => {
      const t = await request()
      t.input.policy[key] = 0n
      expect(await planGrid(t.input)).toMatchObject({ act: false, code: 'INVALID_INPUT' })
      expect(t.simulate).not.toHaveBeenCalled()
    },
  )
})
