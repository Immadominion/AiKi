import { describe, expect, it, vi } from 'vitest'
import { encodeStrategyOperation, type StrategyOperation, strategyPlanHash } from './operation.js'
import { isVerifiedStrategyReceipt } from './receipt.js'
import { a, base, fixture, gridOp, h, lpOp, yieldOp } from './receipt.test-support.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: { manager: string; managerCodeHash: string } }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x60006000') } }
})

describe('strategy operation and finalized outcome boundary', () => {
  it('accepts zero-valued indexed venue/rung topics and reconciles a yield move', async () => {
    const f = fixture()
    const result = await f.run()
    expect(result).toMatchObject({
      status: 'verified',
      receipt: {
        status: 'landed',
        nextNonce: '8',
        outcome: { kind: 'yield', movedAssets: '99', loss: '1' },
      },
    })
    if (result.status === 'verified') expect(isVerifiedStrategyReceipt(result.receipt)).toBe(true)
    expect(f.reader.getBytecode).toHaveBeenCalledWith({
      address: base.binding.vault,
      blockNumber: 100n,
    })
  })
  it.each([0, 1, 2] as const)(
    'decodes all valid yield source indices, source %s',
    async (source) => {
      const f = fixture({
        ...yieldOp,
        source,
        destination: source === 1 ? 2 : 1,
      } as StrategyOperation)
      expect((await f.run()).status).toBe('verified')
    },
  )
  it.each([true, false])(
    'reconciles actual grid inventory in each direction, sell=%s',
    async (nextSell) => {
      const f = fixture({ ...gridOp, before: { ...gridOp.before, nextSell } })
      expect(await f.run()).toMatchObject({
        status: 'verified',
        receipt: { outcome: { kind: 'grid', filled: true, soldToken0: nextSell } },
      })
    },
  )
  it.each([true, false])(
    'does not report an observation as a trade, baseline=%s',
    async (baseline) => {
      const f = fixture({ ...gridOp, baseline }, false)
      expect(await f.run()).toMatchObject({
        status: 'verified',
        receipt: { outcome: { kind: 'grid', filled: false, baseline } },
      })
    },
  )
  it('rejects a fill on the baseline operation', async () => {
    expect((await fixture({ ...gridOp, baseline: true }).run()).status).toBe('blocked')
  })
  it.each([0n, 10n])('verifies LP replacement and custody event, swap=%s', async (swapAmount) => {
    const op = {
      ...lpOp,
      swapAmount,
      ...(swapAmount === 0n ? { minSwapOut: 0n, sqrtPriceLimitX96: 0n } : {}),
    }
    expect(await fixture(op).run()).toMatchObject({
      status: 'verified',
      receipt: { outcome: { kind: 'lp', newTokenId: '43' } },
    })
  })
  it('does not infer the current vault nonce from a revert after possible owner invalidation', async () => {
    const f = fixture()
    f.receipt.status = 'reverted'
    f.receipt.logs = []
    expect(await f.run()).toMatchObject({
      status: 'verified',
      receipt: { status: 'reverted', expectedNonce: '7', nextNonce: null },
    })
  })
  it('never treats mutated, spread or deserialized evidence as verified', async () => {
    const result = await fixture().run()
    if (result.status !== 'verified') throw new Error('Expected verified fixture')
    expect(isVerifiedStrategyReceipt({ ...result.receipt, transactionHash: h('ab') })).toBe(false)
    expect(isVerifiedStrategyReceipt(JSON.parse(JSON.stringify(result.receipt)))).toBe(false)
    expect(() => {
      result.receipt.transactionHash = h('ab')
    }).toThrow()
    const outcome = result.receipt.outcome
    if (!outcome) throw new Error('Missing fixture outcome')
    expect(() => {
      Object.assign(outcome, { movedAssets: '999' })
    }).toThrow()
  })
  it('requires effects on success and no effects on a revert', async () => {
    const missing = fixture()
    missing.receipt.logs = []
    expect((await missing.run()).status).toBe('blocked')
    const reverted = fixture()
    reverted.receipt.status = 'reverted'
    expect((await reverted.run()).status).toBe('blocked')
  })
  it.each([
    ['transactionHash', h('ab')],
    ['blockHash', '0x'],
    ['blockNumber', -1n],
    ['status', 'pending'],
    ['logs', null],
  ])('refuses malformed or different receipt %s', async (field, value) => {
    const f = fixture()
    f.receipt[field as string] = value
    expect((await f.run()).status).toBe('blocked')
  })
  it.each([
    ['hash', h('ab')],
    ['from', a('ab')],
    ['to', a('ab')],
    ['input', '0x87654321'],
    ['value', 1n],
    ['blockHash', h('ab')],
    ['blockNumber', 101n],
  ])('refuses a different transaction envelope %s', async (field, value) => {
    const f = fixture()
    f.tx[field as string] = value
    expect((await f.run()).status).toBe('blocked')
  })
  it.each([
    ['removed', true],
    ['transactionHash', h('ab')],
    ['blockHash', h('ab')],
    ['blockNumber', 101n],
    ['logIndex', -1],
    ['data', '0x12'],
    ['topics', []],
  ])('refuses invalid strategy log %s', async (field, value) => {
    const f = fixture()
    const log = f.logs[0]
    if (!log) throw new Error('Missing fixture log')
    Object.assign(log, { [field as string]: value })
    expect((await f.run()).status).toBe('blocked')
  })
  it('rejects duplicate log indices and duplicate completion events', async () => {
    const duplicateIndex = fixture()
    const first = duplicateIndex.logs[0],
      second = duplicateIndex.logs[1]
    if (!first || !second) throw new Error('Missing fixture logs')
    second.logIndex = first.logIndex
    expect((await duplicateIndex.run()).status).toBe('blocked')
    const duplicateEvent = fixture()
    duplicateEvent.logs.push(duplicateEvent.complete())
    expect((await duplicateEvent.run()).status).toBe('blocked')
  })
  it('never accepts an event emitted by a foreign vault', async () => {
    const f = fixture()
    const log = f.logs[0]
    if (!log) throw new Error('Missing fixture log')
    log.address = a('ab')
    expect((await f.run()).status).toBe('blocked')
  })
  it('rejects a different plan hash, nonce, or policy', async () => {
    for (const changes of [{ planHash: h('ab') }, { nonce: 9n }, { policyHash: h('ab') }]) {
      const f = fixture()
      f.logs[1] = f.event('StrategyExecuted', {
        policyHash: base.binding.policyHash,
        nonce: 8n,
        planHash: strategyPlanHash(yieldOp),
        ...changes,
      })
      expect((await f.run()).status).toBe('blocked')
    }
  })
  it('rejects unexplained grid inventory and repeated cycle values', async () => {
    for (const changes of [
      { inventory0: 91n },
      { inventory1: 60n },
      { cycle: 1n },
      { rung: 1 },
      { actualInput: 0n },
    ]) {
      const f = fixture(gridOp)
      f.logs[0] = f.event('GridFilled', { ...f.result, ...changes })
      expect((await f.run()).status).toBe('blocked')
    }
  })
  it('rejects wrong LP identity, insufficient liquidity and unplanned input', async () => {
    for (const changes of [
      { oldTokenId: 99n },
      { newTokenId: 42n },
      { newTokenId: 0n },
      { liquidity: 99n },
      { amountIn: 11n },
    ]) {
      const f = fixture(lpOp)
      f.logs[0] = f.event('Rebalanced', { ...f.result, ...changes })
      expect((await f.run()).status).toBe('blocked')
    }
  })
  it('rejects runtime and getter binding mismatches', async () => {
    const code = fixture()
    code.reader.getBytecode.mockResolvedValue('0x6001')
    expect((await code.run()).status).toBe('blocked')
    const getter = fixture()
    getter.reader.readContract.mockResolvedValue(h('ab'))
    expect((await getter.run()).status).toBe('blocked')
  })
  it('rejects wrong chain and a chain change during verification', async () => {
    const wrong = fixture()
    wrong.reader.getChainId.mockResolvedValue(97)
    expect((await wrong.run()).status).toBe('blocked')
    const changed = fixture()
    changed.reader.getChainId.mockResolvedValueOnce(56).mockResolvedValueOnce(97)
    expect((await changed.run()).status).toBe('blocked')
  })
  it('requires finalized depth plus canonical block identity after historical reads', async () => {
    const lagged = fixture()
    lagged.finalized.number = 99n
    expect((await lagged.run()).status).toBe('blocked')
    const orphan = fixture()
    orphan.canonical.hash = h('ab')
    expect((await orphan.run()).status).toBe('blocked')
    const fork = fixture()
    fork.finalized.number = 100n
    fork.finalized.hash = h('ab')
    expect((await fork.run()).status).toBe('blocked')
    const f = fixture()
    await f.run()
    expect(f.reader.getBlock.mock.calls).toEqual([
      [{ blockTag: 'finalized' }],
      [{ blockNumber: 100n }],
    ])
  })
  it('fails closed on RPC errors without exposing upstream credentials', async () => {
    const f = fixture()
    f.reader.getTransaction.mockRejectedValue(new Error('secret upstream credential'))
    const result = await f.run()
    expect(result.status).toBe('blocked')
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('rejects mixed kinds, same venue, zero minimum and native chain drift before RPC', async () => {
    for (const operation of [
      { ...yieldOp, binding: { ...base.binding, kind: 'grid' } },
      { ...yieldOp, destination: 0 },
      { ...yieldOp, minReceived: 0n },
      { ...yieldOp, binding: { ...base.binding, chainId: 97 } },
    ] as StrategyOperation[]) {
      expect(() => encodeStrategyOperation(operation)).toThrow()
    }
  })
})
