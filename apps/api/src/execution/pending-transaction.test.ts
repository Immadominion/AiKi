import { beforeEach, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({
  prepare: vi.fn(),
  sign: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  sendLegacy: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: () => ({
    sendRawTransaction: rpc.send,
    waitForTransactionReceipt: rpc.receipt,
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
  rpc.receipt
    .mockReset()
    .mockResolvedValue({ status: 'success', gasUsed: 123n, transactionHash: hash })
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
  rpc.receipt.mockResolvedValue({ status: 'reverted', gasUsed: 123n, transactionHash: hash })
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
