import { describe, expect, it } from 'vitest'
import {
  decodeStoredStrategyOperation,
  encodeStrategyOperation,
  type StrategyOperation,
  strategyOperationDigest,
} from './operation.js'
import { gridOp, lpOp, yieldOp } from './receipt.test-support.js'

const json = (value: unknown): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  )
const decode = (operation: StrategyOperation) => decodeStoredStrategyOperation(json(operation))
const max256 = (1n << 256n) - 1n

describe('strict durable strategy operation codec', () => {
  it.each([yieldOp, gridOp, lpOp])(
    'round-trips $kind without changing its call or intent',
    (operation) => {
      const recovered = decode(operation)
      expect(recovered).toEqual(operation)
      expect(encodeStrategyOperation(recovered)).toBe(encodeStrategyOperation(operation))
      expect(strategyOperationDigest(recovered)).toBe(strategyOperationDigest(operation))
    },
  )
  it('preserves uint256 amounts/nonces and uint64/128/160 boundaries exactly', () => {
    const largeYield: StrategyOperation = {
      ...yieldOp,
      expectedNonce: max256 - 1n,
      deadline: max256,
      assets: max256,
      minReceived: max256 - 1n,
    }
    const largeGrid: StrategyOperation = {
      ...gridOp,
      rungIndex: 0xffff_ffff,
      before: {
        ...gridOp.before,
        inventory0: max256,
        inventory1: (1n << 200n) + 123n,
        cycle: (1n << 64n) - 1n,
      },
    }
    const largeLP: StrategyOperation = {
      ...lpOp,
      expectedTokenId: (1n << 200n) + 41n,
      swapAmount: (1n << 128n) - 1n,
      minSwapOut: max256,
      sqrtPriceLimitX96: (1n << 160n) - 1n,
      minLiquidity: (1n << 128n) - 1n,
    }
    for (const operation of [largeYield, largeGrid, largeLP])
      expect(decode(operation)).toEqual(operation)
  })
  it('recovers an exact zero-swap LP plan without inventing a swap or price limit', () => {
    const operation: StrategyOperation = {
      ...lpOp,
      swapAmount: 0n,
      minSwapOut: 0n,
      sqrtPriceLimitX96: 0n,
    }
    expect(decode(operation)).toEqual(operation)
  })
  it.each(['01', '+1', '-1', '1.0', '1e3', '0x10', ' 1', '1 ', '', 1, 1n, null, true])(
    'rejects noncanonical stored bigint %s instead of coercing it',
    (value) => {
      expect(() => decodeStoredStrategyOperation({ ...json(yieldOp), assets: value })).toThrow()
    },
  )
  it.each([
    { ...yieldOp, expectedNonce: max256 },
    { ...yieldOp, deadline: 0n },
    { ...yieldOp, assets: 1n << 256n },
    { ...yieldOp, minReceived: 0n },
    { ...yieldOp, minReceived: 101n },
    { ...yieldOp, source: 1 },
    { ...gridOp, before: { ...gridOp.before, cycle: 1n << 64n } },
    { ...gridOp, rungIndex: 0x1_0000_0000 },
    { ...gridOp, rungIndex: 0.5 },
    { ...lpOp, minLiquidity: 1n << 128n },
    { ...lpOp, swapAmount: 1n << 128n },
    { ...lpOp, sqrtPriceLimitX96: 1n << 160n },
    { ...lpOp, tickLower: -887273 },
    { ...lpOp, tickUpper: 887273 },
    { ...lpOp, tickLower: 0.5 },
    { ...lpOp, tickLower: 100 },
    { ...lpOp, expectedTokenId: 0n },
    { ...lpOp, swapAmount: 0n },
  ])('rejects overflow or invalid economic/calldata shape %#', (operation) => {
    expect(() => decodeStoredStrategyOperation(json(operation))).toThrow()
  })
  it.each([
    ['rungIndex', '0'],
    ['baseline', 0],
    ['baseline', 'false'],
  ] as const)('does not coerce grid %s', (key, value) => {
    expect(() => decodeStoredStrategyOperation({ ...json(gridOp), [key]: value })).toThrow()
  })
  it('requires exact top-level, binding and grid pre-state keys', () => {
    const missing = json(lpOp)
    delete missing.minBurn0
    const extraBinding = json(yieldOp)
    extraBinding.binding = { ...yieldOp.binding, chain: 56 }
    const extraRung = json(gridOp)
    extraRung.before = { ...json(gridOp.before), ignoredInventory: '900' }
    for (const value of [
      null,
      [],
      {},
      missing,
      { ...json(yieldOp), target: lpOp.binding.vault },
      extraBinding,
      extraRung,
    ])
      expect(() => decodeStoredStrategyOperation(value)).toThrow()
  })
  it.each([
    { chainId: '56' },
    { chainId: 97 },
    { version: '1' },
    { kind: 'grid' },
    { vault: `0x${'00'.repeat(20)}` },
    { controller: yieldOp.binding.vault },
    { policyHash: `0x${'00'.repeat(32)}` },
    { runtimeCodeHash: '0x1234' },
  ])('rejects a changed or malformed binding %#', (changed) => {
    expect(() =>
      decodeStoredStrategyOperation({
        ...json(yieldOp),
        binding: { ...yieldOp.binding, ...changed },
      }),
    ).toThrow()
  })
  it('accepts JSONB key reordering and isolates decoded objects from their source', () => {
    const raw = json(gridOp)
    const reordered = Object.fromEntries(Object.entries(raw).reverse())
    const recovered = decodeStoredStrategyOperation(reordered)
    expect(strategyOperationDigest(recovered)).toBe(strategyOperationDigest(gridOp))
    if (recovered.kind !== 'grid') throw new Error('Wrong kind')
    recovered.before.inventory0 = 0n
    recovered.binding.policyHash = `0x${'aa'.repeat(32)}`
    expect(raw).toEqual(json(gridOp))
  })
  it('commits grid pre-state in the intent even when calldata is unchanged', () => {
    const changed = { ...gridOp, before: { ...gridOp.before, inventory0: 101n } }
    expect(encodeStrategyOperation(changed)).toBe(encodeStrategyOperation(gridOp))
    expect(strategyOperationDigest(changed)).not.toBe(strategyOperationDigest(gridOp))
  })
})
