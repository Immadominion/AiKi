import { expect, it, vi } from 'vitest'
import {
  parseRecoveryArguments,
  type RecoveryAttempt,
  type RecoveryReader,
  type RecoveryStore,
  reconcileExecution,
} from './reconcile.js'

const transactionHash = `0x${'ab'.repeat(32)}` as const
const blockHash = `0x${'cd'.repeat(32)}` as const
const finalizedHash = `0x${'ef'.repeat(32)}` as const
const target = {
  attemptId: '11111111-1111-1111-1111-111111111111',
  chainId: 56,
  transactionHash,
} as const

function harness() {
  const attempt: RecoveryAttempt = {
    id: target.attemptId,
    authorizationId: '22222222-2222-2222-2222-222222222222',
    jobId: '33333333-3333-3333-3333-333333333333',
    chainId: 56,
    transactionHash,
    state: 'UNCONFIRMED',
    createdAt: '2026-09-09T00:00:00.000Z',
    revision: '2026-09-09 00:00:01.123456+00',
  }
  const receipt = { transactionHash, blockHash, blockNumber: 80n, status: 'success' }
  const finalized = { number: 100n, hash: finalizedHash }
  const canonical = { number: 80n, hash: blockHash }
  const reader = {
    getChainId: vi.fn(async () => 56),
    getTransactionReceipt: vi.fn(async (): Promise<unknown> => receipt),
    getBlock: vi.fn(
      async (input: Parameters<RecoveryReader['getBlock']>[0]): Promise<unknown> =>
        'blockTag' in input ? finalized : canonical,
    ),
  }
  const store = {
    get: vi.fn(async (): Promise<RecoveryAttempt | null> => attempt),
    finalizeSuccess: vi.fn(
      async (): Promise<Awaited<ReturnType<RecoveryStore['finalizeSuccess']>>> => 'applied',
    ),
  }
  return {
    attempt,
    receipt,
    finalized,
    canonical,
    reader,
    store,
    run: (apply = false) => reconcileExecution({ target, apply, reader, store }),
  }
}

it('defaults to a read-only dry run and verifies canonicality after finalized state', async () => {
  const h = harness()
  const result = await h.run()
  expect(result).toMatchObject({
    status: 'ready',
    evidence: {
      chainId: 56,
      transactionHash,
      blockNumber: '80',
      blockHash,
      finalizedBlockNumber: '100',
      finalizedBlockHash: finalizedHash,
    },
  })
  expect(h.reader.getBlock.mock.calls).toEqual([
    [{ blockTag: 'finalized' }],
    [{ blockNumber: 80n }],
  ])
  expect(h.reader.getChainId).toHaveBeenCalledTimes(2)
  expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
})

it('applies only verified success using the exact attempt snapshot and receipt evidence', async () => {
  const h = harness()
  const result = await h.run(true)
  expect(result.status).toBe('applied')
  expect(h.store.finalizeSuccess).toHaveBeenCalledWith(h.attempt, result.evidence)
  expect(result.reason).toContain('Counted spend is unchanged')
  expect(result.reason).toContain('no transaction was sent')
})

it.each([56, 97] as const)(
  'requires the recorded chain %s, never the current application default',
  async (chainId) => {
    const h = harness()
    h.attempt.chainId = chainId
    h.reader.getChainId.mockResolvedValue(chainId)
    const result = await reconcileExecution({
      target: { ...target, chainId },
      reader: h.reader,
      store: h.store,
    })
    expect(result.status).toBe('ready')
    expect(result.evidence?.chainId).toBe(chainId)
  },
)

it.each(['missing', 'hash', 'chain', 'terminal', 'no hash'])(
  'refuses an unsuitable durable record before RPC reads: %s',
  async (kind) => {
    const h = harness()
    if (kind === 'missing') h.store.get.mockResolvedValue(null)
    if (kind === 'hash') h.attempt.transactionHash = blockHash
    if (kind === 'chain') h.attempt.chainId = 97
    if (kind === 'terminal') h.attempt.state = 'REVERTED'
    if (kind === 'no hash') {
      h.attempt.state = 'PREPARING'
      delete h.attempt.transactionHash
    }
    expect((await h.run(true)).status).toBe('blocked')
    expect(h.reader.getChainId).not.toHaveBeenCalled()
    expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
  },
)

it('does not repeat finalization of an already landed exact attempt', async () => {
  const h = harness()
  h.attempt.state = 'LANDED'
  expect((await h.run(true)).status).toBe('already_finalized')
  expect(h.reader.getChainId).not.toHaveBeenCalled()
  expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
})

it('does not release or unlock a finalized revert with an unknown reservation amount', async () => {
  const h = harness()
  h.receipt.status = 'reverted'
  const result = await h.run(true)
  expect(result.status).toBe('blocked')
  expect(result.reason).toContain('does not prove its reserved amount')
  expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
})

it.each([
  null,
  {},
  { transactionHash: blockHash },
  { transactionHash: null },
  { blockHash: `0x${'0'.repeat(64)}` },
  { blockHash: 'not-a-hash' },
  { blockNumber: -1n },
  { blockNumber: '80' },
  { blockNumber: null },
  { status: 'unknown' },
])('refuses malformed or mismatched receipt evidence: %#', async (invalid) => {
  const h = harness()
  h.reader.getTransactionReceipt.mockResolvedValue(
    invalid === null || Object.keys(invalid).length === 0 ? invalid : { ...h.receipt, ...invalid },
  )
  const result = await h.run(true)
  expect(result.status).toBe('blocked')
  expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
})

it.each([
  null,
  {},
  { number: null, hash: finalizedHash },
  { number: -1n, hash: finalizedHash },
  { number: 100, hash: finalizedHash },
  { number: 100n, hash: null },
  { number: 100n, hash: `0x${'0'.repeat(64)}` },
  { number: 100n, hash: '0x12' },
  { number: 79n, hash: finalizedHash },
  { number: 80n, hash: finalizedHash },
])('holds the attempt when finality is missing, malformed or behind: %#', async (finalized) => {
  const h = harness()
  h.reader.getBlock.mockResolvedValueOnce(finalized)
  expect((await h.run(true)).status).toBe('blocked')
  expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
})

it('accepts the exact receipt block itself as the finalized checkpoint', async () => {
  const h = harness()
  h.reader.getBlock.mockResolvedValueOnce({ number: 80n, hash: blockHash })
  expect((await h.run()).status).toBe('ready')
})

it('detects a branch change that occurs during the finalized lookup', async () => {
  const h = harness()
  h.reader.getBlock.mockImplementation(async (input) => {
    if ('blockTag' in input) {
      h.canonical.hash = transactionHash
      return h.finalized
    }
    return h.canonical
  })
  expect((await h.run(true)).status).toBe('blocked')
  expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
})

it.each([null, { number: 81n, hash: blockHash }, { number: 80n, hash: null }])(
  'refuses missing or malformed canonical block results: %#',
  async (canonical) => {
    const h = harness()
    h.reader.getBlock.mockResolvedValueOnce(h.finalized).mockResolvedValueOnce(canonical)
    expect((await h.run(true)).status).toBe('blocked')
    expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
  },
)

it.each(['initial', 'changed'])('refuses a wrong RPC chain: %s', async (when) => {
  const h = harness()
  if (when === 'initial') h.reader.getChainId.mockResolvedValue(97)
  else h.reader.getChainId.mockResolvedValueOnce(56).mockResolvedValueOnce(97)
  expect((await h.run(true)).status).toBe('blocked')
  expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
})

it.each(['chain', 'receipt', 'finality', 'canonical'])(
  'sanitizes failed %s reads and retains the lock',
  async (step) => {
    const h = harness()
    const error = new Error('https://private-rpc/secret-key')
    if (step === 'chain') h.reader.getChainId.mockRejectedValueOnce(error)
    if (step === 'receipt') h.reader.getTransactionReceipt.mockRejectedValueOnce(error)
    if (step === 'finality') h.reader.getBlock.mockRejectedValueOnce(error)
    if (step === 'canonical')
      h.reader.getBlock.mockResolvedValueOnce(h.finalized).mockRejectedValueOnce(error)
    const result = await h.run(true)
    expect(result.status).toBe('blocked')
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(h.store.finalizeSuccess).not.toHaveBeenCalled()
  },
)

it.each(['changed', 'already_finalized'] as const)(
  'reports concurrent finalization outcome %s without retrying',
  async (status) => {
    const h = harness()
    h.store.finalizeSuccess.mockResolvedValue(status)
    expect((await h.run(true)).status).toBe(status)
    expect(h.store.finalizeSuccess).toHaveBeenCalledOnce()
  },
)

it('requires an exact target and an explicit apply flag, with no force/refund option', () => {
  const args = ['--attempt', target.attemptId, '--chain', '56', '--hash', transactionHash]
  expect(parseRecoveryArguments(args)).toEqual({ ...target, apply: false })
  expect(parseRecoveryArguments([...args, '--apply'])).toEqual({ ...target, apply: true })
  for (const invalid of [
    [],
    [...args, '--force'],
    [...args, '--release', '10'],
    [...args, '--apply', '--apply'],
    [...args, '--chain', '97'],
    ['--attempt', 'not-a-uuid', '--chain', '56', '--hash', transactionHash],
    ['--attempt', target.attemptId, '--chain', '1', '--hash', transactionHash],
    ['--attempt', target.attemptId, '--chain', '56', '--hash', '0x00'],
  ])
    expect(() => parseRecoveryArguments(invalid)).toThrow()
})
