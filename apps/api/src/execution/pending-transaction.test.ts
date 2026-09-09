import { beforeEach, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({
  prepare: vi.fn(),
  sign: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  sendLegacy: vi.fn(),
  chain: vi.fn(),
  block: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: () => ({
    sendRawTransaction: rpc.send,
    waitForTransactionReceipt: rpc.receipt,
    getChainId: rpc.chain,
    getBlock: rpc.block,
  }),
  createWalletClient: () => ({
    prepareTransactionRequest: rpc.prepare,
    signTransaction: rpc.sign,
    sendTransaction: rpc.sendLegacy,
  }),
}))
const { keccak256 } = await import('viem')
const { execute } = await import('./executor.js')
const signed = '0x010203' as const
const hash = keccak256(signed)
const address = `0x${'11'.repeat(20)}` as const
const blockHash = `0x${'cd'.repeat(32)}` as const
const goodReceipt = {
  status: 'success',
  gasUsed: 123n,
  transactionHash: hash,
  blockNumber: 80n,
  blockHash,
}
const request = {
  rpcUrl: 'http://127.0.0.1:1',
  chainId: 56,
  delegationManager: address,
  relayerKey: `0x${'00'.repeat(31)}01` as const,
  delegation: {
    delegate: address,
    delegator: address,
    authority: `0x${'ff'.repeat(32)}` as const,
    caveats: [],
    salt: 0n,
    epoch: 0n,
    signature: '0x' as const,
  },
  action: {
    target: address,
    selector: '0xa9059cbb',
    asset: address,
    amount: 3n,
    at: new Date().toISOString(),
  },
  callData: '0x' as const,
}
beforeEach(() => {
  vi.clearAllMocks()
  rpc.prepare.mockReset().mockResolvedValue({ to: address, data: '0x', nonce: 0 })
  rpc.sign.mockReset().mockResolvedValue(signed)
  rpc.send.mockReset().mockResolvedValue(hash)
  rpc.sendLegacy.mockReset().mockResolvedValue(hash)
  rpc.receipt.mockReset().mockResolvedValue(goodReceipt)
  rpc.chain.mockReset().mockResolvedValue(56)
  rpc.block
    .mockReset()
    .mockImplementation(async (input) =>
      'blockTag' in input ? { number: 100n, hash: blockHash } : { number: 80n, hash: blockHash },
    )
})

it('persists the locally calculated hash before any broadcast', async () => {
  const onPrepared = vi.fn(async (preparedHash) => {
    expect(preparedHash).toBe(hash)
    expect(rpc.send).not.toHaveBeenCalled()
    expect(rpc.receipt).not.toHaveBeenCalled()
  })
  expect(await execute({ ...request, onPrepared })).toMatchObject({
    status: 'landed',
    transactionHash: hash,
  })
  expect(onPrepared).toHaveBeenCalledOnce()
  expect(rpc.send).toHaveBeenCalledWith({ serializedTransaction: signed })
})

it('retains the submitted hash and reports uncertainty when receipt lookup times out', async () => {
  rpc.receipt.mockRejectedValue(new Error('credential-bearing-rpc-error-fixture'))
  const result = await execute(request)
  expect(result).toMatchObject({ status: 'unconfirmed', transactionHash: hash })
  expect(JSON.stringify({ ...result, gasUsed: String(result.gasUsed) })).not.toContain(
    'credential-bearing-rpc-error-fixture',
  )
  expect(rpc.send).toHaveBeenCalledOnce()
})

it('keeps an ambiguous broadcast acknowledgement unresolved instead of sending again', async () => {
  rpc.send.mockRejectedValue(new Error('socket closed after accepting bytes'))
  const onPrepared = vi.fn(async () => {})
  expect(await execute({ ...request, onPrepared })).toMatchObject({
    status: 'unconfirmed',
    transactionHash: hash,
  })
  expect(onPrepared).toHaveBeenCalledWith(hash)
  expect(rpc.send).toHaveBeenCalledOnce()
  expect(rpc.receipt).not.toHaveBeenCalled()
})

it('does not broadcast if durable hash persistence fails', async () => {
  const result = await execute({
    ...request,
    onPrepared: async () => {
      throw new Error('database unavailable')
    },
  })
  expect(result.status).toBe('refused')
  expect(rpc.send).not.toHaveBeenCalled()
  expect(rpc.receipt).not.toHaveBeenCalled()
})

it.each(['prepare', 'sign'] as const)(
  'only calls a pre-broadcast %s failure refused',
  async (stage) => {
    rpc[stage].mockRejectedValue(new Error('private-key-fixture'))
    const result = await execute(request)
    expect(result).toMatchObject({ status: 'refused' })
    expect(result.transactionHash).toBeUndefined()
    expect(result.revertReason).not.toContain('private-key-fixture')
    expect(rpc.send).not.toHaveBeenCalled()
  },
)

it('distinguishes a mined revert from an unknown result', async () => {
  rpc.receipt.mockResolvedValue({ ...goodReceipt, status: 'reverted' })
  expect(await execute(request)).toEqual({
    status: 'reverted',
    gasUsed: 123n,
    transactionHash: hash,
  })
})

it('does not count a cancellation or replacement receipt as this action landing', async () => {
  rpc.receipt.mockResolvedValue({
    status: 'success',
    gasUsed: 123n,
    transactionHash: `0x${'ff'.repeat(32)}`,
  })
  expect(await execute(request)).toMatchObject({ status: 'unconfirmed', transactionHash: hash })
})

it('requires the receipt to identify the exact prepared transaction', async () => {
  rpc.receipt.mockResolvedValue({ status: 'success', gasUsed: 123n })
  expect(await execute(request)).toMatchObject({ status: 'unconfirmed', transactionHash: hash })
})

it.each([56, 97])(
  'requires three confirmations AND finalized canonical identity on chain %s',
  async (chainId) => {
    rpc.chain.mockResolvedValue(chainId)
    expect((await execute({ ...request, chainId })).status).toBe('landed')
    expect(rpc.receipt).toHaveBeenCalledWith({ hash, timeout: 60_000, confirmations: 3 })
    expect(rpc.block.mock.calls).toEqual([[{ blockTag: 'finalized' }], [{ blockNumber: 80n }]])
    expect(rpc.chain).toHaveBeenCalledTimes(2)
  },
)

it('refuses a wrong RPC chain before preparing, signing or broadcasting', async () => {
  rpc.chain.mockResolvedValue(97)
  expect((await execute(request)).status).toBe('refused')
  expect(rpc.prepare).not.toHaveBeenCalled()
  expect(rpc.sign).not.toHaveBeenCalled()
  expect(rpc.send).not.toHaveBeenCalled()
})

it.each(['success', 'reverted'])(
  'keeps a mined %s unresolved while finality is behind',
  async (status) => {
    rpc.receipt.mockResolvedValue({ ...goodReceipt, status })
    rpc.block.mockResolvedValue({ number: 79n, hash: blockHash })
    expect(await execute(request)).toMatchObject({
      status: 'unconfirmed',
      transactionHash: hash,
      gasUsed: 0n,
    })
    expect(rpc.send).toHaveBeenCalledOnce()
    expect(rpc.block).toHaveBeenCalledOnce()
  },
)

it.each([
  undefined,
  null,
  {},
  { number: 100, hash: blockHash },
  { number: -1n, hash: blockHash },
  { number: 100n },
  { number: 100n, hash: `0x${'00'.repeat(32)}` },
  { number: 80n, hash: `0x${'ef'.repeat(32)}` },
])('retains the signer lock for invalid or contradictory finality checkpoint %#', async (block) => {
  rpc.block.mockResolvedValue(block)
  expect((await execute(request)).status).toBe('unconfirmed')
})

it.each([
  { blockNumber: undefined },
  { blockNumber: 80 },
  { blockNumber: -1n },
  { blockHash: undefined },
  { blockHash: `0x${'00'.repeat(32)}` },
  { status: 'unknown' },
])('rejects malformed mined receipt identity or status %#', async (patch) => {
  rpc.receipt.mockResolvedValue({ ...goodReceipt, ...patch })
  expect((await execute(request)).status).toBe('unconfirmed')
})

it('retains the signer lock when finalized lookup is unavailable', async () => {
  rpc.block.mockRejectedValue(new Error('private-rpc-fixture'))
  const result = await execute(request)
  expect(result.status).toBe('unconfirmed')
  expect(result.revertReason).not.toContain('private-rpc-fixture')
})

it.each([
  { number: 80n, hash: `0x${'ef'.repeat(32)}` },
  { number: 81n, hash: blockHash },
  { number: 80n, hash: null },
])('rejects canonical block disagreement after reading finality %#', async (block) => {
  rpc.block.mockResolvedValueOnce({ number: 100n, hash: blockHash }).mockResolvedValueOnce(block)
  expect((await execute(request)).status).toBe('unconfirmed')
  expect(rpc.block.mock.calls).toEqual([[{ blockTag: 'finalized' }], [{ blockNumber: 80n }]])
})

it('retains the signer lock when the RPC chain changes during confirmation', async () => {
  rpc.chain.mockResolvedValueOnce(56).mockResolvedValueOnce(97)
  expect((await execute(request)).status).toBe('unconfirmed')
})
