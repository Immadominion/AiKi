import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionOutcome, RedemptionRequest } from '../execution/executor.js'
import { executeStrategyOperation } from './execution.js'
import { isVerifiedStrategyReceipt } from './receipt.js'
import { fixture, h, yieldOp } from './receipt.test-support.js'
import { simulationFixture } from './simulation.test-support.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: { manager: string; managerCodeHash: string } }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x60006000') } }
})
// Public deterministic TEST key. Never funded or used by these tests to send anything.
const testKey = `0x${'01'.repeat(32)}` as Hex
async function setup() {
  const f = fixture(yieldOp, true, privateKeyToAccount(testKey).address)
  const { simulation } = await simulationFixture(f.target.operation, f.delegation)
  const order: string[] = []
  const store = {
    begin: vi.fn(async () => ({ acquired: true as const, attemptId: 'test-attempt' })),
    recordHash: vi.fn(async () => {
      order.push('persist')
    }),
    requireReview: vi.fn(async () => {}),
    refuseBeforeBroadcast: vi.fn(async () => {}),
    settle: vi.fn(async (_id, evidence) => {
      expect(isVerifiedStrategyReceipt(evidence)).toBe(true)
      return 'applied' as const
    }),
  }
  const send = vi.fn(async (request: RedemptionRequest): Promise<ExecutionOutcome> => {
    await request.onPrepared?.(f.target.transactionHash)
    order.push('broadcast')
    return { status: 'landed', transactionHash: f.target.transactionHash, gasUsed: 1n }
  })
  const input = {
    store,
    watchId: 'test-watch',
    expectedRevision: '3',
    operation: f.target.operation,
    simulation,
    gasBudgetWei: 6_000_000_000_000n,
    request: {
      rpcUrl: 'https://example.invalid',
      chainId: 56,
      delegationManager: f.target.manager,
      relayerKey: testKey,
      delegation: f.delegation,
    },
    reader: f.reader,
    send,
  }
  return { ...f, input, store, send, order, run: () => executeStrategyOperation(input) }
}
describe('durable strategy execution orchestration', () => {
  it('requires an issued exact quote and a positive sufficient hard gas ceiling before claiming', async () => {
    const f = await setup()
    expect(
      (await executeStrategyOperation({ ...f.input, simulation: { ...f.input.simulation } }))
        .status,
    ).toBe('blocked')
    for (const gasBudgetWei of [0n, 1n, 1n << 256n])
      expect((await executeStrategyOperation({ ...f.input, gasBudgetWei })).status).toBe('blocked')
    f.input.operation = { ...f.input.operation, deadline: f.input.operation.deadline + 1n }
    expect((await f.run()).status).toBe('blocked')
    expect(f.store.begin).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })
  it('persists the exact hash before its only broadcast and verifies effects before settlement', async () => {
    const f = await setup()
    expect(await f.run()).toMatchObject({
      status: 'landed',
      outcome: { kind: 'yield', movedAssets: '99' },
    })
    expect(f.order).toEqual(['persist', 'broadcast'])
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({ maxGasCostWei: f.input.gasBudgetWei }),
    )
    expect(f.store.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        manager: f.target.manager,
        executor: f.target.executor,
        envelopeHash: f.target.envelopeHash,
      }),
    )
    expect(
      JSON.stringify(f.store.begin.mock.calls, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(testKey)
    expect(f.store.settle).toHaveBeenCalledTimes(1)
    expect(f.store.requireReview).not.toHaveBeenCalled()
  })
  it('does not send behind a durable claim refusal', async () => {
    const f = await setup()
    const blocked = {
      ...f.input,
      store: {
        ...f.store,
        begin: vi.fn(async () => ({ acquired: false as const, reason: 'pending' as const })),
      },
    }
    expect((await executeStrategyOperation(blocked)).status).toBe('blocked')
    expect(f.send).not.toHaveBeenCalled()
  })
  it('refuses wrong chain, manager or delegate before claiming', async () => {
    for (const change of [{ chainId: 97 }, { delegationManager: `0x${'ab'.repeat(20)}` as Hex }]) {
      const f = await setup()
      Object.assign(f.input.request, change)
      expect((await f.run()).status).toBe('blocked')
      expect(f.store.begin).not.toHaveBeenCalled()
    }
    const f = await setup()
    f.input.request.delegation.delegate = `0x${'ab'.repeat(20)}`
    expect((await f.run()).status).toBe('blocked')
    expect(f.store.begin).not.toHaveBeenCalled()
  })
  it('keeps uncertainty locked when the transport throws after persisting its hash', async () => {
    const f = await setup()
    f.send.mockImplementation(async (request) => {
      await request.onPrepared?.(f.target.transactionHash)
      throw new Error('lost acknowledgement')
    })
    expect((await f.run()).status).toBe('needs_review')
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.store.requireReview).toHaveBeenCalledOnce()
    expect(f.store.settle).not.toHaveBeenCalled()
    expect(f.store.refuseBeforeBroadcast).not.toHaveBeenCalled()
  })
  it('uses a newly verified exact receipt even when the initial transport timed out', async () => {
    const f = await setup()
    f.send.mockImplementation(async (request) => {
      await request.onPrepared?.(f.target.transactionHash)
      return { status: 'unconfirmed', transactionHash: f.target.transactionHash, gasUsed: 0n }
    })
    expect((await f.run()).status).toBe('landed')
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('does not accept transaction success without its strategy events', async () => {
    const f = await setup()
    f.receipt.logs = []
    expect((await f.run()).status).toBe('needs_review')
    expect(f.store.settle).not.toHaveBeenCalled()
  })
  it('does not accept a returned replacement hash or a sender that skips pre-broadcast persistence', async () => {
    const f = await setup()
    f.send.mockResolvedValue({
      status: 'landed',
      transactionHash: f.target.transactionHash,
      gasUsed: 1n,
    })
    expect((await f.run()).status).toBe('needs_review')
    const other = await setup()
    other.send.mockImplementation(async (request) => {
      await request.onPrepared?.(other.target.transactionHash)
      return { status: 'landed', transactionHash: h('ab'), gasUsed: 1n }
    })
    expect((await other.run()).status).toBe('needs_review')
    expect(other.store.settle).not.toHaveBeenCalled()
  })
  it('records a known preparation refusal but preserves ambiguous persistence failures', async () => {
    const f = await setup()
    f.send.mockResolvedValue({ status: 'refused', gasUsed: 0n })
    expect((await f.run()).status).toBe('refused')
    expect(f.store.refuseBeforeBroadcast).toHaveBeenCalledOnce()
    const uncertain = await setup()
    uncertain.send.mockResolvedValue({ status: 'refused', gasUsed: 0n })
    uncertain.store.refuseBeforeBroadcast.mockRejectedValue(new Error('hash commit uncertain'))
    expect((await uncertain.run()).status).toBe('needs_review')
  })
  it('records a verified revert without fabricating a fill', async () => {
    const f = await setup()
    f.receipt.status = 'reverted'
    f.receipt.logs = []
    expect(await f.run()).toMatchObject({ status: 'reverted' })
    expect(f.store.settle).toHaveBeenCalledWith(
      'test-attempt',
      expect.objectContaining({ status: 'reverted', nextNonce: null }),
    )
  })
})
