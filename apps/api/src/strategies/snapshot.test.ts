import type { Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { isVerifiedStrategySnapshot, MAX_SNAPSHOT_GRID_RUNGS } from './snapshot.js'
import { snapshotFixture as fixture } from './snapshot.test-support.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: { manager: string } }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x6005') } }
})

const a = (byte: string) => `0x${byte.repeat(20)}` as Hex
const h = (byte: string) => `0x${byte.repeat(32)}` as Hex
const zero = a('00')
const owner = a('99'),
  vault = a('11'),
  controller = a('22'),
  factory = a('33')
const token0 = a('71'),
  token1 = a('72'),
  nfpm = a('80')
const blockNumber = 100n,
  timestamp = 1_900_000_000n

describe('opaque finalized strategy snapshots', () => {
  it.each(['yield', 'grid', 'lp'] as const)(
    'reads complete %s state only at one finalized block',
    async (kind) => {
      const f = fixture(kind),
        result = await f.run()
      expect(result.status).toBe('verified')
      if (result.status !== 'verified') throw new Error('Expected verified fixture')
      expect(result.snapshot).toMatchObject({
        binding: f.target.binding,
        owner,
        manager: mainnet.manager,
        factory: f.target.factory,
        block: { chainId: 56, number: blockNumber, hash: h('aa'), timestamp },
        nonce: 7n,
        paused: false,
        expiresAt: timestamp + 1000n,
        minInterval: 60n,
        maxDeadlineDelay: 120n,
        lastExecutionAt: timestamp - 60n,
        state: { kind },
      })
      expect(f.reader.getBlock.mock.calls).toEqual([[{ blockTag: 'finalized' }], [{ blockNumber }]])
      expect(f.reader.getChainId).toHaveBeenCalledTimes(2)
      for (const [input] of [
        ...f.reader.readContract.mock.calls,
        ...f.reader.getBytecode.mock.calls,
      ])
        expect(input.blockNumber).toBe(blockNumber)
    },
  )
  it('distinguishes yield tracked holdings, unsolicited balances, turnover and losses', async () => {
    expect(await fixture().run()).toMatchObject({
      status: 'verified',
      snapshot: {
        state: {
          kind: 'yield',
          fundedPrincipal: 300n,
          turnover: 200n,
          cumulativeLoss: 1n,
          managedIdle: 100n,
          actualIdle: 101n,
          managedVenusShares: 150n,
          actualVenusShares: 150n,
          managedAaveScaled: 50n,
          actualAaveScaled: 50n,
          limits: { maxPrincipal: 1000n, maxLossBps: 100 },
        },
      },
    })
  })
  it('preserves large uint256 amounts and nonces without a floating-point conversion', async () => {
    const f = fixture()
    const large = (1n << 200n) + 123n
    f.setVault('operationNonce', large)
    f.setVault('managedIdle', large)
    f.setVault('fundedPrincipal', large)
    f.setVault('limits', [large, 200n, 2000n, 10n, large, large, 2n, 20n, 100])
    f.set(a('61'), 'balanceOf', large + 1n, [vault])
    expect(await f.run()).toMatchObject({
      status: 'verified',
      snapshot: { nonce: large, state: { managedIdle: large, actualIdle: large + 1n } },
    })
  })
  it('retains all grid rung inventory, cycle and arming state and owner-invalidated baseline', async () => {
    const f = fixture('grid')
    f.setVault('operationNonce', 8n)
    expect(await f.run()).toMatchObject({
      status: 'verified',
      snapshot: {
        state: {
          kind: 'grid',
          allocated0: 30n,
          allocated1: 70n,
          turnover0: 200n,
          turnover1: 300n,
          initialized: true,
          observationNonce: 7n,
          baselineRequired: true,
          lastObservedTick: -50,
          rungs: [
            { index: 0, state: { inventory0: 10n, cycle: 0n, nextSell: true, armed: false } },
            { index: 1, state: { inventory1: 40n, cycle: 1n, nextSell: false, armed: true } },
          ],
        },
      },
    })
  })
  it('retains LP exact NFT custody, liquidity, accrued fee accounting and idle assets', async () => {
    expect(await fixture('lp').run()).toMatchObject({
      status: 'verified',
      snapshot: {
        state: {
          kind: 'lp',
          currentTokenId: 42n,
          positionLiquidity: 500n,
          idle0: 10n,
          idle1: 20n,
          cumulativeLossQuote: 3n,
          enrolled: true,
          position: {
            owner: vault,
            operator: zero,
            token0,
            token1,
            liquidity: 500n,
            tickLower: -100,
            tickUpper: 100,
            feeGrowthInside0LastX128: 1n,
            feeGrowthInside1LastX128: 2n,
            tokensOwed0: 3n,
            tokensOwed1: 4n,
          },
        },
      },
    })
  })
  it('returns paused and expired truthfully without claiming activation readiness', async () => {
    const f = fixture()
    f.setVault('paused', true)
    f.setVault('expiresAt', timestamp - 1n)
    expect(await f.run()).toMatchObject({
      status: 'verified',
      snapshot: { paused: true, expiresAt: timestamp - 1n },
    })
  })
  it.each([false, true])(
    'represents LP before enrollment or after withdrawal without fabricating custody, enrolled=%s',
    async (enrolled) => {
      const f = fixture('lp')
      for (const field of ['currentTokenId', 'positionLiquidity', 'idle0', 'idle1'])
        f.setVault(field, 0n)
      f.setVault('enrolled', enrolled)
      expect(await f.run()).toMatchObject({
        status: 'verified',
        snapshot: { state: { enrolled, currentTokenId: 0n, position: null } },
      })
      expect(f.reader.readContract.mock.calls.some(([call]) => call.address === nfpm)).toBe(false)
    },
  )
  it('reads the current controller owner, not an old registration owner', async () => {
    const f = fixture()
    f.set(controller, 'owner', a('98'))
    expect(await f.run()).toMatchObject({ status: 'verified', snapshot: { owner: a('98') } })
  })
  it('fails closed without reviewed factory configuration before any RPC', async () => {
    const f = fixture()
    delete f.target.factory
    expect((await f.run()).status).toBe('blocked')
    expect(f.reader.getChainId).not.toHaveBeenCalled()
  })
  it('requires a server-reviewed binding enforcer and its exact runtime code', async () => {
    const missing = fixture()
    delete missing.target.bindingEnforcer
    expect((await missing.run()).status).toBe('blocked')
    expect(missing.reader.getChainId).not.toHaveBeenCalled()
    const changed = fixture()
    changed.codes.set(a('34'), '0x6007')
    expect((await changed.run()).status).toBe('blocked')
  })
  it.each([
    'vault',
    'controller',
    'policyHash',
    'runtimeCodeHash',
    'chainId',
    'kind',
    'version',
  ] as const)('rejects invalid binding %s before RPC', async (field) => {
    const f = fixture()
    Object.assign(f.target.binding, {
      [field]: field === 'chainId' ? 97 : field === 'version' ? 2 : 'invalid',
    })
    expect((await f.run()).status).toBe('blocked')
    expect(f.reader.getChainId).not.toHaveBeenCalled()
  })
  it.each([mainnet.manager, factory, vault, controller, a('61')])(
    'rejects missing code at %s',
    async (address) => {
      const f = fixture()
      f.codes.delete(address)
      expect((await f.run()).status).toBe('blocked')
    },
  )
  it.each([mainnet.manager, factory, vault, controller])(
    'rejects changed reviewed runtime at %s',
    async (address) => {
      const f = fixture()
      f.codes.set(address, '0x123456')
      expect((await f.run()).status).toBe('blocked')
    },
  )
  it.each(['0x', '0x0', '0xz1'] as Hex[])(
    'rejects malformed or empty bytecode %s',
    async (code) => {
      const f = fixture()
      f.codes.set(vault, code)
      expect((await f.run()).status).toBe('blocked')
    },
  )
  it.each([
    [factory, 'manager', a('ab')],
    [factory, 'accountRuntimeHash', h('ab')],
    [controller, 'DELEGATION_MANAGER', a('ab')],
    [controller, 'owner', zero],
    [controller, 'owner', controller],
    [vault, 'controller', a('ab')],
    [vault, 'policyHash', h('ab')],
    [vault, 'strategyKind', h('ab')],
    [vault, 'operationSelector', '0x12345678'],
  ])('rejects mismatched identity %s/%s', async (address, name, value) => {
    const f = fixture()
    f.set(String(address), String(name), value)
    expect((await f.run()).status).toBe('blocked')
  })
  it('rejects a factory that did not register the exact vault', async () => {
    const f = fixture()
    f.set(factory, 'isVault', false, [vault])
    expect((await f.run()).status).toBe('blocked')
  })
  it.each([0n, 33n, 2n ** 255n])(
    'bounds Grid rung count %s before issuing rung calls',
    async (count) => {
      const f = fixture('grid')
      f.setVault('rungCount', count)
      expect((await f.run()).status).toBe('blocked')
      expect(
        f.reader.readContract.mock.calls.some(([call]) =>
          ['rungPolicy', 'rungState'].includes(call.functionName),
        ),
      ).toBe(false)
      expect(MAX_SNAPSHOT_GRID_RUNGS).toBe(32)
    },
  )
  it('rejects grid protocol drift, incomplete rung state and inconsistent aggregate inventories', async () => {
    const code = fixture('grid')
    code.codes.set(token0, '0x123456')
    expect((await code.run()).status).toBe('blocked')
    const missing = fixture('grid')
    missing.bad(vault, 'rungState', { inventory0: 10n }, [0])
    expect((await missing.run()).status).toBe('blocked')
    const totals = fixture('grid')
    totals.setVault('allocated0', 31n)
    expect((await totals.run()).status).toBe('blocked')
    const future = fixture('grid')
    future.setVault('observationNonce', 8n)
    expect((await future.run()).status).toBe('blocked')
  })
  it.each(['yield', 'grid', 'lp'] as const)(
    'rejects %s tracked balances without actual backing',
    async (kind) => {
      const f = fixture(kind)
      f.set(kind === 'yield' ? a('61') : token0, 'balanceOf', 0n, [vault])
      expect((await f.run()).status).toBe('blocked')
    },
  )
  it.each([
    ['ownerOf', a('ab')],
    ['getApproved', a('ab')],
    ['positions', [0n, zero, token0, token1, 500, -100, 100, 499n, 1n, 2n, 3n, 4n]],
    ['positions', [0n, zero, a('70'), token1, 500, -100, 100, 500n, 1n, 2n, 3n, 4n]],
    ['positions', [0n, a('ab'), token0, token1, 500, -100, 100, 500n, 1n, 2n, 3n, 4n]],
    ['positions', [0n, zero, token0, token1, 500, -99, 100, 500n, 1n, 2n, 3n, 4n]],
  ])('rejects wrong LP custody, approval or position in %s', async (name, value) => {
    const f = fixture('lp')
    f.set(nfpm, String(name), value, [42n])
    expect((await f.run()).status).toBe('blocked')
  })
  it.each([
    ['operationNonce', 9007199254740992],
    ['operationNonce', -1n],
    ['operationNonce', 1n << 256n],
    ['paused', 'false'],
    ['minInterval', 1n],
    ['minInterval', -1],
    ['maxDeadlineDelay', 3601],
    ['limits', [1n, 2n]],
    ['lastExecutionAt', timestamp + 1n],
  ])('rejects malformed or inconsistent ABI value %s', async (name, value) => {
    const f = fixture()
    f.bad(vault, String(name), value)
    expect((await f.run()).status).toBe('blocked')
  })
  it.each([
    ['number', -1n],
    ['number', 100],
    ['hash', h('00')],
    ['timestamp', '1900000000'],
  ])('rejects invalid finalized block %s', async (name, value) => {
    const f = fixture()
    f.finalized[String(name)] = value
    expect((await f.run()).status).toBe('blocked')
  })
  it('rejects canonical hash/time/number changes and RPC chain drift after all state reads', async () => {
    for (const changed of [{ hash: h('ab') }, { timestamp: timestamp + 1n }, { number: 101n }]) {
      const f = fixture()
      Object.assign(f.canonical, changed)
      expect((await f.run()).status).toBe('blocked')
    }
    const f = fixture()
    f.reader.getChainId.mockResolvedValueOnce(56).mockResolvedValueOnce(97)
    expect((await f.run()).status).toBe('blocked')
    expect(f.reader.readContract).toHaveBeenCalled()
  })
  it('rejects a wrong initial chain before reading the vault', async () => {
    const f = fixture()
    f.reader.getChainId.mockResolvedValue(97)
    expect((await f.run()).status).toBe('blocked')
    expect(f.reader.readContract).not.toHaveBeenCalled()
  })
  it('copies caller-owned configuration before the first RPC await', async () => {
    const f = fixture()
    f.reader.getChainId.mockImplementationOnce(async () => {
      if (!f.target.factory) throw new Error('Expected factory')
      f.target.binding.policyHash = h('ab')
      f.target.factory.runtimeCodeHash = h('ab')
      return 56
    })
    expect(await f.run()).toMatchObject({
      status: 'verified',
      snapshot: { binding: { policyHash: h('44') } },
    })
  })
  it('does not permit forgery, spread copies, deserialization or mutation of nested grid state', async () => {
    const f = fixture('grid'),
      result = await f.run()
    if (result.status !== 'verified') throw new Error('Expected verified fixture')
    const s = result.snapshot
    expect(isVerifiedStrategySnapshot(s)).toBe(true)
    expect(isVerifiedStrategySnapshot({ ...s })).toBe(false)
    expect(isVerifiedStrategySnapshot(structuredClone(s))).toBe(false)
    expect(
      isVerifiedStrategySnapshot(
        JSON.parse(JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? v.toString() : v))),
      ),
    ).toBe(false)
    expect(() => Object.assign(s, { paused: true })).toThrow()
    expect(() => Object.assign(s.binding, { policyHash: h('ab') })).toThrow()
    expect(() => Object.assign(s.block, { number: 99n })).toThrow()
    if (s.state.kind !== 'grid') throw new Error('Expected grid')
    const grid = s.state
    const rung = grid.rungs[0]
    if (!rung) throw new Error('Expected rung')
    expect(() => Object.assign(rung.state, { inventory0: 999n })).toThrow()
    expect(() => Object.assign(rung.policy, { buyTick: 999 })).toThrow()
    expect(() => Object.assign(grid.rungs, { length: 0 })).toThrow()
  })
  it('sanitizes RPC failures and never returns partial verified state', async () => {
    const f = fixture()
    f.reader.readContract.mockRejectedValue(new Error('private rpc credential'))
    const result = await f.run()
    expect(result.status).toBe('blocked')
    expect(JSON.stringify(result)).not.toContain('credential')
    expect('snapshot' in result).toBe(false)
  })
})
