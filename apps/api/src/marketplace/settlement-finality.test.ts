import { createPublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ViemSettlementFinalityReader } from './settlement-finality.js'

vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: vi.fn(),
}))

const HASH = `0x${'11'.repeat(32)}` as const
const RECEIPT_BLOCK_HASH = `0x${'22'.repeat(32)}` as const
const FINALIZED_BLOCK_HASH = `0x${'33'.repeat(32)}` as const
const OTHER_HASH = `0x${'44'.repeat(32)}` as const
const CONTRACT = `0x${'ab'.repeat(20)}` as const

function fixture() {
  const receipt = {
    status: 'success',
    transactionHash: HASH,
    blockNumber: 100n,
    blockHash: RECEIPT_BLOCK_HASH,
    logs: [
      {
        address: CONTRACT,
        topics: [OTHER_HASH],
        data: '0x',
        transactionHash: HASH,
        logIndex: 7,
        blockNumber: 100n,
        blockHash: RECEIPT_BLOCK_HASH,
        removed: false,
      },
    ],
  }
  const finalized = { number: 200n, hash: FINALIZED_BLOCK_HASH }
  const canonical = { number: 100n, hash: RECEIPT_BLOCK_HASH }
  const client = {
    getChainId: vi.fn().mockResolvedValue(56),
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) =>
      args.blockTag === 'finalized' || args.blockNumber === finalized.number
        ? finalized
        : canonical,
    ),
  }
  vi.mocked(createPublicClient).mockReturnValue(client as never)
  return {
    receipt,
    finalized,
    canonical,
    client,
    reader: new ViemSettlementFinalityReader('http://127.0.0.1:1'),
  }
}

beforeEach(() => vi.clearAllMocks())

describe('marketplace finalized settlement receipt identity', () => {
  it('accepts the exact successful receipt only after canonical block and chain rechecks', async () => {
    const f = fixture()
    const result = await f.reader.finalizedReceipt(HASH)
    expect(result).toEqual({
      ...f.receipt,
      logs: f.receipt.logs.map(({ removed: _, ...log }) => log),
    })
    expect(f.client.getChainId).toHaveBeenCalledTimes(2)
    expect(f.client.getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
    expect(f.client.getBlock).toHaveBeenCalledWith({ blockNumber: 200n })
  })

  it('accepts an exact canonical reverted receipt as reverted, never successful', async () => {
    const f = fixture()
    f.receipt.status = 'reverted'
    f.receipt.logs = []
    expect((await f.reader.finalizedReceipt(HASH))?.status).toBe('reverted')
  })

  it('rejects a receipt for another transaction hash', async () => {
    const f = fixture()
    f.client.getTransactionReceipt.mockResolvedValue({ ...f.receipt, transactionHash: OTHER_HASH })
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  it('rejects an RPC on the wrong chain before requesting a receipt', async () => {
    const f = fixture()
    f.client.getChainId.mockResolvedValue(97)
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled()
  })

  it('rejects a chain change during verification', async () => {
    const f = fixture()
    f.client.getChainId.mockResolvedValueOnce(56).mockResolvedValueOnce(97)
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  it('rejects an orphaned receipt below the finalized height', async () => {
    const f = fixture()
    f.canonical.hash = OTHER_HASH
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  it('rejects a canonical lookup for the wrong height', async () => {
    const f = fixture()
    f.canonical.number = 99n
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  it('rejects a receipt above the finalized height', async () => {
    const f = fixture()
    f.finalized.number = 99n
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  it('accepts a receipt at the exact finalized height only with the same canonical hash', async () => {
    const f = fixture()
    f.finalized.number = 100n
    f.finalized.hash = RECEIPT_BLOCK_HASH
    expect((await f.reader.finalizedReceipt(HASH))?.transactionHash).toBe(HASH)
    f.finalized.hash = OTHER_HASH
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  for (const [name, finalized] of [
    ['missing finalized hash', { number: 200n, hash: undefined }],
    ['zero finalized hash', { number: 200n, hash: `0x${'00'.repeat(32)}` }],
    ['negative finalized height', { number: -1n, hash: FINALIZED_BLOCK_HASH }],
    ['untyped finalized height', { number: 200, hash: FINALIZED_BLOCK_HASH }],
  ]) {
    it(`rejects ${name}`, async () => {
      const f = fixture()
      f.client.getBlock.mockResolvedValue(finalized as never)
      expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
    })
  }

  it('rejects a finalized anchor that changes before the canonical recheck', async () => {
    const f = fixture()
    f.client.getBlock.mockImplementation(async (args) => {
      if (args.blockTag === 'finalized') return f.finalized
      if (args.blockNumber === f.finalized.number) return { ...f.finalized, hash: OTHER_HASH }
      return f.canonical
    })
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  it('rejects a receipt block that changes during verification', async () => {
    const f = fixture()
    let receiptReads = 0
    f.client.getBlock.mockImplementation(async (args) => {
      if (args.blockTag === 'finalized' || args.blockNumber === f.finalized.number)
        return f.finalized
      receiptReads += 1
      return receiptReads === 1 ? f.canonical : { ...f.canonical, hash: OTHER_HASH }
    })
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  for (const [name, change] of [
    ['foreign transaction', { transactionHash: OTHER_HASH }],
    ['foreign block', { blockHash: OTHER_HASH }],
    ['foreign height', { blockNumber: 99n }],
    ['removed event', { removed: true }],
    ['invalid index', { logIndex: -1 }],
  ] as const) {
    it(`rejects a ${name} log inside the claimed receipt`, async () => {
      const f = fixture()
      f.client.getTransactionReceipt.mockResolvedValue({
        ...f.receipt,
        logs: [{ ...f.receipt.logs[0], ...change }],
      })
      expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
    })
  }

  it('rejects malformed status rather than interpreting it as a revert', async () => {
    const f = fixture()
    f.receipt.status = 'unexpected'
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  it('rejects duplicate log identities', async () => {
    const f = fixture()
    const log = f.receipt.logs[0]
    if (!log) throw Error('Missing fixture log')
    f.receipt.logs.push({ ...log })
    expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
  })

  it('rejects an invalid requested hash without any RPC reads', async () => {
    const f = fixture()
    expect(await f.reader.finalizedReceipt('0x1234')).toBeNull()
    expect(f.client.getChainId).not.toHaveBeenCalled()
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled()
  })

  for (const method of ['getChainId', 'getTransactionReceipt', 'getBlock'] as const) {
    it(`fails closed without exposing ${method} transport errors`, async () => {
      const f = fixture()
      f.client[method].mockRejectedValue(Error('Untrusted RPC details'))
      expect(await f.reader.finalizedReceipt(HASH)).toBeNull()
    })
  }
})
