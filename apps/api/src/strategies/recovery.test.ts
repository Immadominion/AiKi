import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { isVerifiedStrategyReceipt, type VerifiedStrategyReceipt } from './receipt.js'
import { fixture, gridOp, h, lpOp, yieldOp } from './receipt.test-support.js'
import { recoverStrategyOperation } from './recovery.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x60006000') } }
})

type RecoveryInput = Parameters<typeof recoverStrategyOperation>[0]
type Pending = NonNullable<Awaited<ReturnType<RecoveryInput['store']['getPendingAttempt']>>>

function setup(operation = yieldOp as typeof yieldOp | typeof gridOp | typeof lpOp, filled = true) {
  const f = fixture(operation, filled)
  const pending: Pending = { attemptId: 'recovery-attempt', ...structuredClone(f.target) }
  const store = {
    getPendingAttempt: vi.fn(async (_attemptId: string): Promise<Pending | null> => pending),
    settle: vi.fn(
      async (
        _attemptId: string,
        evidence: VerifiedStrategyReceipt,
      ): Promise<'applied' | 'already_settled' | 'changed'> => {
        expect(isVerifiedStrategyReceipt(evidence)).toBe(true)
        expect(Object.isFrozen(evidence)).toBe(true)
        return 'applied'
      },
    ),
    requireReview: vi.fn(async (_attemptId: string) => {}),
  }
  const input: RecoveryInput = { store, attemptId: pending.attemptId, reader: f.reader }
  return { ...f, input, store, pending, run: () => recoverStrategyOperation(input) }
}

describe('receipt-only immutable strategy recovery', () => {
  it.each([yieldOp, gridOp, lpOp])(
    'recovers the exact stored $kind attempt through the same verifier and settlement',
    async (operation) => {
      const f = setup(operation)
      const result = await f.run()
      expect(result).toMatchObject({
        status: 'landed',
        attemptId: f.pending.attemptId,
        transactionHash: f.target.transactionHash,
        outcome: { kind: operation.kind },
      })
      expect(f.store.getPendingAttempt).toHaveBeenCalledExactlyOnceWith(f.pending.attemptId)
      expect(f.reader.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith({
        hash: f.target.transactionHash,
      })
      expect(f.reader.getTransaction).toHaveBeenCalledExactlyOnceWith({
        hash: f.target.transactionHash,
      })
      expect(f.store.settle).toHaveBeenCalledExactlyOnceWith(
        f.pending.attemptId,
        expect.objectContaining({ transactionHash: f.target.transactionHash, nextNonce: '8' }),
      )
      expect(f.store.requireReview).not.toHaveBeenCalled()
    },
  )
  it('preserves a finalized no-fill Grid observation instead of inventing a trade', async () => {
    const f = setup({ ...gridOp, baseline: true }, false)
    expect(await f.run()).toMatchObject({
      status: 'landed',
      outcome: { kind: 'grid', filled: false, baseline: true },
    })
    expect(f.store.settle).toHaveBeenCalledOnce()
  })
  it('settles a finalized revert without an outcome or fabricated next nonce', async () => {
    const f = setup()
    f.receipt.status = 'reverted'
    f.receipt.logs = []
    const result = await f.run()
    expect(result).toEqual({
      status: 'reverted',
      attemptId: f.pending.attemptId,
      transactionHash: f.target.transactionHash,
    })
    expect(f.store.settle).toHaveBeenCalledExactlyOnceWith(
      f.pending.attemptId,
      expect.objectContaining({ status: 'reverted', nextNonce: null }),
    )
    expect(f.store.requireReview).not.toHaveBeenCalled()
  })
  it('returns not_found for an absent or already-terminal pending record without touching RPC', async () => {
    const f = setup()
    f.store.getPendingAttempt.mockResolvedValue(null)
    expect(await f.run()).toEqual({ status: 'not_found', attemptId: f.input.attemptId })
    expect(f.reader.getChainId).not.toHaveBeenCalled()
    expect(f.store.requireReview).not.toHaveBeenCalled()
    expect(f.store.settle).not.toHaveBeenCalled()
  })
  it('keeps a no-hash preparation locked without consulting RPC or inventing a hash', async () => {
    const f = setup()
    f.pending.transactionHash = null
    expect(await f.run()).toEqual({ status: 'needs_review', attemptId: f.input.attemptId })
    expect(f.reader.getChainId).not.toHaveBeenCalled()
    expect(f.store.requireReview).toHaveBeenCalledExactlyOnceWith(f.input.attemptId)
    expect(f.store.settle).not.toHaveBeenCalled()
  })
  it('rejects a store record belonging to another attempt', async () => {
    const f = setup()
    f.pending.attemptId = 'another-attempt'
    expect(await f.run()).toEqual({ status: 'needs_review', attemptId: 'recovery-attempt' })
    expect(f.store.requireReview).toHaveBeenCalledExactlyOnceWith('recovery-attempt')
    expect(f.reader.getChainId).not.toHaveBeenCalled()
    expect(f.store.settle).not.toHaveBeenCalled()
  })
  it.each([
    'missing',
    'throwing',
    'unfinalized',
    'unsupported-finality',
    'reorg',
    'wrong-chain',
    'missing-events',
    'replacement',
    'wrong-call',
    'wrong-envelope',
    'wrong-runtime',
  ])('keeps %s chain evidence locked and never settles or follows a replacement', async (mode) => {
    const f = setup()
    if (mode === 'missing')
      f.input.reader = { ...f.reader, getTransactionReceipt: vi.fn(async () => null) }
    if (mode === 'throwing')
      f.reader.getTransactionReceipt.mockRejectedValue(new Error('private provider URL'))
    if (mode === 'unfinalized') f.finalized.number = 99n
    if (mode === 'unsupported-finality')
      f.reader.getBlock.mockRejectedValue(new Error('unsupported finalized'))
    if (mode === 'reorg') f.canonical.hash = h('ab')
    if (mode === 'wrong-chain') f.reader.getChainId.mockResolvedValue(97)
    if (mode === 'missing-events') f.receipt.logs = []
    if (mode === 'replacement') f.receipt.transactionHash = h('ab')
    if (mode === 'wrong-call') f.pending.operation = { ...yieldOp, assets: 101n }
    if (mode === 'wrong-envelope') f.pending.envelopeHash = h('ab')
    if (mode === 'wrong-runtime') f.reader.getBytecode.mockResolvedValue('0x6001')
    expect(await f.run()).toEqual({ status: 'needs_review', attemptId: f.input.attemptId })
    expect(f.store.settle).not.toHaveBeenCalled()
    expect(f.store.requireReview).toHaveBeenCalledExactlyOnceWith(f.input.attemptId)
    expect(f.reader.getTransactionReceipt.mock.calls.length).toBeLessThanOrEqual(1)
    expect(f.reader.getTransaction.mock.calls.length).toBeLessThanOrEqual(1)
    expect(f.reader.getTransactionReceipt).not.toHaveBeenCalledWith({ hash: h('ab') })
    expect(f.reader.getTransaction).not.toHaveBeenCalledWith({ hash: h('ab') })
  })
  it('checks canonicality after finality so a branch change cannot settle an orphan', async () => {
    const f = setup()
    f.reader.getBlock.mockImplementation(async (input) => {
      if ('blockTag' in input) {
        f.canonical.hash = h('ab')
        return f.finalized
      }
      return f.canonical
    })
    expect((await f.run()).status).toBe('needs_review')
    expect(f.reader.getBlock.mock.calls).toEqual([
      [{ blockTag: 'finalized' }],
      [{ blockNumber: 100n }],
    ])
    expect(f.store.settle).not.toHaveBeenCalled()
  })
  it('captures the complete stored target and requested id before subsequent RPC awaits', async () => {
    const f = setup()
    f.reader.getTransactionReceipt.mockImplementation(async () => {
      f.pending.transactionHash = h('ab')
      f.pending.envelopeHash = h('ab')
      f.pending.operation.expectedNonce = 9n
      f.pending.operation.binding.policyHash = h('ab')
      f.pending.attemptId = 'mutated-record'
      f.input.attemptId = 'mutated-input'
      return f.receipt
    })
    expect(await f.run()).toMatchObject({
      status: 'landed',
      attemptId: 'recovery-attempt',
      transactionHash: f.target.transactionHash,
    })
    expect(f.store.settle).toHaveBeenCalledExactlyOnceWith(
      'recovery-attempt',
      expect.objectContaining({
        transactionHash: f.target.transactionHash,
        expectedNonce: '7',
        policyHash: yieldOp.binding.policyHash,
      }),
    )
  })
  it('accepts an idempotent atomic settlement race without a second settlement call', async () => {
    const f = setup()
    f.store.settle.mockResolvedValue('already_settled')
    expect((await f.run()).status).toBe('landed')
    expect(f.store.settle).toHaveBeenCalledOnce()
    expect(f.store.requireReview).not.toHaveBeenCalled()
  })
  it('keeps an atomic state conflict under review, not falsely landed', async () => {
    const f = setup()
    f.store.settle.mockResolvedValue('changed')
    expect((await f.run()).status).toBe('needs_review')
    expect(f.store.settle).toHaveBeenCalledOnce()
    expect(f.store.requireReview).toHaveBeenCalledExactlyOnceWith(f.input.attemptId)
  })
  it.each(['lookup', 'settlement', 'review'] as const)(
    'contains %s storage failure without releasing an uncertain lock or leaking details',
    async (phase) => {
      const f = setup()
      if (phase === 'lookup')
        f.store.getPendingAttempt.mockRejectedValue(new Error('private database URL'))
      if (phase === 'settlement')
        f.store.settle.mockRejectedValue(new Error('commit acknowledgement lost'))
      if (phase === 'review') {
        f.pending.transactionHash = null
        f.store.requireReview.mockRejectedValue(new Error('private database URL'))
      }
      expect(await f.run()).toEqual({ status: 'needs_review', attemptId: f.input.attemptId })
      expect(f.store.requireReview).toHaveBeenCalledOnce()
      expect(f.store.settle.mock.calls.length).toBe(phase === 'settlement' ? 1 : 0)
    },
  )
  it('has no signer, executor, submission or activation dependency', async () => {
    const source = await readFile(new URL('./recovery.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(
      /from\s+['"][^'"]*(?:executor|execution|signer|wallet)[^'"]*['"]|executeRedemption|sendRawTransaction|activateOwner/,
    )
    const f = setup()
    expect(Object.keys(f.input.store).sort()).toEqual([
      'getPendingAttempt',
      'requireReview',
      'settle',
    ])
    await f.run()
    expect(f.store.settle).toHaveBeenCalledOnce()
  })
})
