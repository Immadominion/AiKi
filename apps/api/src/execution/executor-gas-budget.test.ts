import { ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import { type Hex, keccak256 } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeRedemption, type RedemptionRequest } from './executor.js'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  sign: vi.fn(),
  chain: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  block: vi.fn(),
}))
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    http: vi.fn(() => ({})),
    createWalletClient: vi.fn(() => ({
      prepareTransactionRequest: mocks.prepare,
      signTransaction: mocks.sign,
    })),
    createPublicClient: vi.fn(() => ({
      getChainId: mocks.chain,
      sendRawTransaction: mocks.send,
      waitForTransactionReceipt: mocks.receipt,
      getBlock: mocks.block,
    })),
  }
})

// Published Anvil account #1 only. No wallet signs: all transport/preparation/signing is mocked.
const FIXTURE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const SIGNED_FIXTURE = '0x01020304' as Hex
const TX_HASH = keccak256(SIGNED_FIXTURE)
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex
const address = (byte: string) => `0x${byte.repeat(20)}` as Hex
const MAX_UINT256 = (1n << 256n) - 1n
function request(cap: unknown = 20n): RedemptionRequest {
  return {
    rpcUrl: 'http://mock.invalid',
    chainId: 56,
    delegationManager: address('11'),
    relayerKey: FIXTURE_KEY,
    target: address('22'),
    callData: '0x12345678',
    maxGasCostWei: cap as bigint,
    delegation: {
      delegate: address('33'),
      delegator: address('44'),
      authority: ROOT_AUTHORITY,
      caveats: [],
      salt: 1n,
      epoch: 0n,
      signature: '0x1234',
    },
  }
}
function noBroadcast() {
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.receipt).not.toHaveBeenCalled()
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.prepare.mockResolvedValue({ gas: 10n, gasPrice: 2n })
  mocks.sign.mockResolvedValue(SIGNED_FIXTURE)
  mocks.chain.mockResolvedValue(56)
  mocks.send.mockResolvedValue(TX_HASH)
  mocks.receipt.mockResolvedValue({
    transactionHash: TX_HASH,
    status: 'success',
    blockNumber: 10n,
    blockHash: BLOCK_HASH,
    gasUsed: 8n,
  })
  mocks.block.mockResolvedValue({ number: 10n, hash: BLOCK_HASH })
})

describe('prepared full-transaction hard gas budget', () => {
  it.each([56, 97])(
    'explicitly prepares canonical legacy fees on BSC chain %s',
    async (chainId) => {
      mocks.chain.mockResolvedValue(chainId)
      expect(await executeRedemption({ ...request(), chainId })).toMatchObject({ status: 'landed' })
      expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith({
        to: address('11'),
        data: expect.stringMatching(/^0x[0-9a-f]+$/),
        type: 'legacy',
      })
    },
  )
  it('leaves automatic transaction-type selection unchanged on other chains', async () => {
    expect(await executeRedemption({ ...request(), chainId: 1 })).toMatchObject({
      status: 'landed',
    })
    expect(mocks.prepare.mock.calls[0]?.[0]).not.toHaveProperty('type')
  })
  it.each([20n, 21n])('accepts maximum legacy charge within inclusive budget %s', async (cap) => {
    const onPrepared = vi.fn(async () => undefined)
    const result = await executeRedemption({ ...request(cap), onPrepared })
    expect(result).toMatchObject({ status: 'landed', transactionHash: TX_HASH, gasUsed: 8n })
    expect(mocks.sign).toHaveBeenCalledWith({ gas: 10n, gasPrice: 2n })
    expect(onPrepared).toHaveBeenCalledWith(TX_HASH)
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ serializedTransaction: SIGNED_FIXTURE })
    const sendOrder = mocks.send.mock.invocationCallOrder[0]
    if (sendOrder === undefined) throw new Error('Expected one mock broadcast')
    expect(onPrepared.mock.invocationCallOrder[0]).toBeLessThan(sendOrder)
  })
  it('refuses over-budget prepared gas before signing, hash persistence or broadcasting', async () => {
    const onPrepared = vi.fn()
    expect(await executeRedemption({ ...request(19n), onPrepared })).toMatchObject({
      status: 'refused',
      gasUsed: 0n,
    })
    expect(mocks.sign).not.toHaveBeenCalled()
    expect(onPrepared).not.toHaveBeenCalled()
    noBroadcast()
  })
  it('uses EIP-1559 maximum fee, not its smaller priority fee', async () => {
    mocks.prepare.mockResolvedValue({ gas: 10n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n })
    expect(await executeRedemption({ ...request(999n), chainId: 1 })).toMatchObject({
      status: 'refused',
    })
    expect(mocks.sign).not.toHaveBeenCalled()
    noBroadcast()
    expect(await executeRedemption({ ...request(1000n), chainId: 1 })).toMatchObject({
      status: 'landed',
    })
  })
  it('cannot hide a high maximum fee behind a low legacy gasPrice in an ambiguous prepared request', async () => {
    mocks.prepare.mockResolvedValue({
      gas: 10n,
      gasPrice: 1n,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 1n,
    })
    expect(await executeRedemption(request(20n))).toMatchObject({ status: 'refused' })
    expect(mocks.sign).not.toHaveBeenCalled()
    noBroadcast()
  })
  it.each([
    {},
    { gas: 10n },
    { gasPrice: 2n },
    { gas: 0n, gasPrice: 2n },
    { gas: -1n, gasPrice: 2n },
    { gas: 10, gasPrice: 2n },
    { gas: 10n, gasPrice: 0n },
    { gas: 10n, gasPrice: -1n },
    { gas: 10n, gasPrice: 2 },
    { gas: 10n, maxPriorityFeePerGas: 1n },
    { gas: 10n, maxFeePerGas: 0n },
  ])('refuses missing or invalid prepared gas/fee %#', async (prepared) => {
    mocks.prepare.mockResolvedValue(prepared)
    expect(await executeRedemption(request())).toMatchObject({ status: 'refused', gasUsed: 0n })
    expect(mocks.sign).not.toHaveBeenCalled()
    noBroadcast()
  })
  it.each([0n, -1n, MAX_UINT256 + 1n, 20, '20', Number.POSITIVE_INFINITY, Number.NaN, null])(
    'rejects malformed or out-of-uint256 cap %#',
    async (cap) => {
      expect(await executeRedemption(request(cap))).toMatchObject({
        status: 'refused',
        gasUsed: 0n,
      })
      expect(mocks.sign).not.toHaveBeenCalled()
      noBroadcast()
    },
  )
  it('compares a 512-bit gas-times-fee product without wrapping to a cheap charge', async () => {
    mocks.prepare.mockResolvedValue({ gas: 1n << 128n, gasPrice: 1n << 128n })
    expect(await executeRedemption(request(MAX_UINT256))).toMatchObject({ status: 'refused' })
    expect(mocks.sign).not.toHaveBeenCalled()
    noBroadcast()
  })
  it('never broadcasts after hash persistence rejects, including a possible committed/lost acknowledgement', async () => {
    const onPrepared = vi.fn(async () => {
      throw new Error('fixture database acknowledgement lost')
    })
    const result = await executeRedemption({ ...request(), onPrepared })
    expect(result).toMatchObject({ status: 'refused', gasUsed: 0n })
    expect(result.transactionHash).toBeUndefined()
    expect(mocks.sign).toHaveBeenCalledTimes(1)
    expect(onPrepared).toHaveBeenCalledWith(TX_HASH)
    noBroadcast()
    expect(result.revertReason).not.toContain('database')
    expect(result.revertReason).not.toContain(FIXTURE_KEY)
  })
  it('awaits durable hash persistence before the only possible broadcast', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const onPrepared = vi.fn(() => gate)
    const execution = executeRedemption({ ...request(), onPrepared })
    await vi.waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1))
    noBroadcast()
    if (!release) throw new Error('Missing fixture gate')
    release()
    expect(await execution).toMatchObject({ status: 'landed' })
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('preserves the signed hash and uncertainty after a lost broadcast acknowledgement, without retry', async () => {
    mocks.send.mockRejectedValue(new Error('fixture RPC acknowledgement lost'))
    const onPrepared = vi.fn(async () => undefined)
    expect(await executeRedemption({ ...request(), onPrepared })).toMatchObject({
      status: 'unconfirmed',
      transactionHash: TX_HASH,
      gasUsed: 0n,
    })
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.receipt).not.toHaveBeenCalled()
    expect(onPrepared).toHaveBeenCalledWith(TX_HASH)
  })
  it('keeps the pre-existing non-strategy path optional when no cap was requested', async () => {
    const r = request()
    delete r.maxGasCostWei
    mocks.prepare.mockResolvedValue({})
    expect(await executeRedemption(r)).toMatchObject({ status: 'landed' })
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
})
