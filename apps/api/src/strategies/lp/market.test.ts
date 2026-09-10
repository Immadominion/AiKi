import { describe, expect, it, vi } from 'vitest'
import { isVerifiedLPPoolState, readLPPoolState } from './market.js'
import { a, h, LP_TEST_POLICY, lpFixture, NOW } from './planner.test-support.js'

vi.mock('../../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x6005') } }
})

describe('same-block opaque LP market proof', () => {
  async function setup() {
    const f = lpFixture(),
      checked = await f.base.run()
    if (checked.status !== 'verified') throw new Error('Expected vault')
    return {
      ...f,
      snapshot: checked.snapshot,
      read: () =>
        readLPPoolState(
          checked.snapshot,
          { runtimeCodeHash: LP_TEST_POLICY.poolRuntimeCodeHash },
          f.poolReader,
        ),
    }
  }
  it('pins every pool read to the exact snapshot block and returns retained TWAP plus liquidity', async () => {
    const f = await setup(),
      result = await f.read()
    expect(result).toMatchObject({
      status: 'verified',
      market: { snapshot: f.snapshot, pool: a('83'), spot: 0, twap: 0, window: 300 },
    })
    for (const [call] of f.poolReader.readContract.mock.calls)
      expect(call.blockNumber).toBe(f.snapshot.block.number)
    expect(f.poolReader.getBlock.mock.calls).toEqual([[{ blockNumber: f.snapshot.block.number }]])
  })
  it('floors negative fractional mean ticks and supports canonical cumulative wraparound', async () => {
    const f = await setup()
    const maximum = (1n << 159n) - 1n
    f.poolValues.set('observe', [
      [(1n << 55n) - 1n, BigInt.asIntN(56, (1n << 55n) - 1n - 1n)],
      [maximum, maximum + (300n << 128n) / 10n ** 24n],
    ])
    expect(await f.read()).toMatchObject({ status: 'verified', market: { twap: -1 } })
    f.poolValues.set('observe', [
      [(1n << 55n) - 1n, BigInt.asIntN(56, (1n << 55n) - 1n + 300n)],
      [(1n << 160n) - 1n, BigInt.asUintN(160, (1n << 160n) - 1n + (300n << 128n) / 10n ** 24n)],
    ])
    expect(await f.read()).toMatchObject({ status: 'verified', market: { twap: 1 } })
  })
  it.each(['factory', 'token0', 'token1'])('rejects foreign pool %s', async (name) => {
    const f = await setup()
    f.poolValues.set(name, a('ab'))
    expect((await f.read()).status).toBe('blocked')
  })
  it.each([
    ['liquidity', 0n],
    ['fee', 3000],
    ['tickSpacing', 1],
    ['slot0', [1n << 96n, 0, 0, 0, 0, 0, true]],
    ['slot0', [1n << 96n, 1, 0, 2, 2, 0, true]],
    ['slot0', [1n << 96n, 0, 0, 2, 2, 0, false]],
    [
      'observe',
      [
        [0n, 1n],
        [0n, 0n],
      ],
    ],
    ['observe', [[0n], [0n, 1n]]],
    [
      'observe',
      [
        [0n, 30_300n],
        [0n, (300n << 128n) / 10n ** 24n],
      ],
    ],
    ['observations:1', [Number(NOW - 299n), 0n, 0n, true]],
  ])('rejects malformed or unsafe market state %s', async (name, value) => {
    const f = await setup()
    f.poolValues.set(String(name), value)
    expect((await f.read()).status).toBe('blocked')
  })
  it('uses observation zero only if the oldest ring slot is explicitly uninitialized', async () => {
    const f = await setup()
    f.poolValues.set('observations:1', [0, 0n, 0n, false])
    expect((await f.read()).status).toBe('verified')
    f.poolValues.set('observations:0', [0, 0n, 0n, false])
    expect((await f.read()).status).toBe('blocked')
  })
  it('rejects missing/wrong runtime, final block drift and chain switches', async () => {
    const f = await setup()
    f.poolReader.getBytecode.mockResolvedValueOnce(undefined)
    expect((await f.read()).status).toBe('blocked')
    f.poolReader.getBytecode.mockResolvedValueOnce('0x12')
    expect((await f.read()).status).toBe('blocked')
    f.poolReader.getChainId.mockResolvedValueOnce(56).mockResolvedValueOnce(97)
    expect((await f.read()).status).toBe('blocked')
    f.base.canonical.hash = h('ab')
    expect((await f.read()).status).toBe('blocked')
  })
  it('refuses forged proofs, mutation and leaking RPC errors', async () => {
    const f = await setup(),
      result = await f.read()
    if (result.status !== 'verified') throw new Error('Expected market')
    expect(isVerifiedLPPoolState(result.market)).toBe(true)
    expect(isVerifiedLPPoolState({ ...result.market })).toBe(false)
    expect(() => Object.assign(result.market, { spot: 999 })).toThrow()
    f.poolReader.readContract.mockRejectedValue(new Error('private rpc secret'))
    expect(JSON.stringify(await f.read())).not.toContain('secret')
  })
})
