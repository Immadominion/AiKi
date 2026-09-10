import { describe, expect, it, vi } from 'vitest'
import { isVerifiedGridMarketSnapshot, readGridMarketSnapshot } from './market.js'
import { MAX_SQRT_RATIO, MAX_TICK, sqrtRatioAtTick } from './math.js'
import { a, gridFixture, NOW } from './test-support.js'

vi.mock('../../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x6005') } }
})
describe('same-block grid market proofs', () => {
  it('checks actual oracle history, liquidity and allowances at only the custody block', async () => {
    const f = gridFixture(0),
      { snapshot, market } = await f.evidence()
    expect(market).toMatchObject({
      spot: 0,
      twap: 0,
      currentLiquidity: 1000n,
      harmonicLiquidity: 1000n,
      allowance0: 0n,
      allowance1: 0n,
    })
    expect(isVerifiedGridMarketSnapshot(market, snapshot)).toBe(true)
    expect(isVerifiedGridMarketSnapshot({ ...market }, snapshot)).toBe(false)
    expect(isVerifiedGridMarketSnapshot(market, await f.snapshot())).toBe(false)
    expect(Object.isFrozen(market)).toBe(true)
    for (const [call] of f.reader.readContract.mock.calls) expect(call.blockNumber).toBe(100n)
  })
  it('floors negative mean ticks and wraps int56/uint160 oracle counters', async () => {
    const f = gridFixture(-2)
    const delta = (300n * ((1n << 160n) - 1n)) / (1000n << 32n)
    const tickStart = -(1n << 55n) + 100n,
      liquidityStart = (1n << 160n) - 20n
    f.set(
      f.pool,
      'observe',
      [
        [tickStart, BigInt.asIntN(56, tickStart - 301n)],
        [liquidityStart, BigInt.asUintN(160, liquidityStart + delta)],
      ],
      [[300, 0]],
    )
    expect((await f.evidence()).market.twap).toBe(-2)
  })
  it('uses observation zero when the next ring slot is uninitialized', async () => {
    const f = gridFixture()
    f.set(f.pool, 'observations', [0, 0n, 0n, false], [1])
    f.set(f.pool, 'observations', [NOW - 301, 0n, 0n, true], [0])
    expect((await f.evidence()).market.twap).toBe(0)
  })
  it.each([
    'locked',
    'short-history',
    'uninitialized',
    'low-current',
    'low-harmonic',
    'deviation',
    'zero-delta',
    'bad-sqrt',
    'max-sqrt',
    'short-array',
    'approval0',
    'approval1',
  ])('fails closed for %s', async (mode) => {
    const f = gridFixture(),
      snapshot = await f.snapshot()
    if (mode === 'locked') f.set(f.pool, 'slot0', [sqrtRatioAtTick(0), 0, 0, 2, 2, 0, false])
    if (mode === 'short-history') f.set(f.pool, 'observations', [NOW - 299, 0n, 0n, true], [1])
    if (mode === 'uninitialized') {
      f.set(f.pool, 'observations', [0, 0n, 0n, false], [1])
      f.set(f.pool, 'observations', [0, 0n, 0n, false], [0])
    }
    if (mode === 'low-current') f.set(f.pool, 'liquidity', 99n)
    if (mode === 'low-harmonic')
      f.set(
        f.pool,
        'observe',
        [
          [0n, 0n],
          [0n, (300n << 128n) / 50n],
        ],
        [[300, 0]],
      )
    if (mode === 'deviation')
      f.set(
        f.pool,
        'observe',
        [
          [0n, 30300n],
          [0n, (300n << 128n) / 1000n],
        ],
        [[300, 0]],
      )
    if (mode === 'zero-delta')
      f.set(
        f.pool,
        'observe',
        [
          [0n, 0n],
          [0n, 0n],
        ],
        [[300, 0]],
      )
    if (mode === 'bad-sqrt') f.set(f.pool, 'slot0', [sqrtRatioAtTick(2), 0, 0, 2, 2, 0, true])
    if (mode === 'max-sqrt')
      f.set(f.pool, 'slot0', [MAX_SQRT_RATIO, MAX_TICK - 1, 0, 2, 2, 0, true])
    if (mode === 'short-array') f.set(f.pool, 'observe', [[0n], [0n]], [[300, 0]])
    if (mode === 'approval0' || mode === 'approval1')
      f.set(a(mode === 'approval0' ? '71' : '72'), 'allowance', 1n, [
        f.target.binding.vault,
        a('81'),
      ])
    expect((await readGridMarketSnapshot(snapshot, f.reader)).status).toBe('blocked')
  })
  it('rejects changed pool code, canonical block or network after custody verification', async () => {
    for (const mode of ['code', 'block', 'chain']) {
      const f = gridFixture(),
        snapshot = await f.snapshot()
      if (mode === 'code') f.codes.set(f.pool, '0x6006')
      if (mode === 'block') f.canonical.hash = `0x${'bb'.repeat(32)}`
      if (mode === 'chain') f.reader.getChainId.mockResolvedValue(97)
      expect((await readGridMarketSnapshot(snapshot, f.reader)).status).toBe('blocked')
    }
  })
})
