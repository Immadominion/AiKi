import { beforeEach, expect, it, vi } from 'vitest'
import { creditDeposit, type DepositConfig } from './deposit.js'
import { DuplicateDeposit, InMemoryCreditStore } from './store.js'

const rpc = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
  getChainId: vi.fn(),
  getBlockNumber: vi.fn(),
  getBlock: vi.fn(),
  readContract: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => rpc),
}))
const { toEventSelector, parseAbiItem } = await import('viem')
const TRANSFER = toEventSelector(
  parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
)
const owner = `0x${'12'.repeat(20)}`
const treasury = `0x${'ab'.repeat(20)}` as const
const token = `0x${'34'.repeat(20)}` as const
const other = `0x${'56'.repeat(20)}`
const hash = `0x${'78'.repeat(32)}`
const blockHash = `0x${'90'.repeat(32)}`
const config: DepositConfig = {
  rpcUrl: 'http://127.0.0.1:1',
  chainId: 97,
  decimals: 6,
  treasury,
  token,
}
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const transfer = (
  options: { from?: string; to?: string; address?: string; amount?: bigint } = {},
) => ({
  address: options.address ?? token,
  topics: [TRANSFER, topic(options.from ?? owner), topic(options.to ?? treasury)],
  data: `0x${(options.amount ?? 1_000_000n).toString(16).padStart(64, '0')}`,
})
const receipt = (logs = [transfer()], status = 'success') => ({
  status,
  logs,
  blockNumber: 100n,
  blockHash,
  transactionHash: hash,
})
let credits: InMemoryCreditStore
beforeEach(() => {
  credits = new InMemoryCreditStore()
  rpc.getTransactionReceipt.mockReset().mockResolvedValue(receipt())
  rpc.getChainId.mockReset().mockResolvedValue(97)
  rpc.getBlockNumber.mockReset().mockResolvedValue(102n)
  rpc.getBlock.mockReset().mockResolvedValue({ hash: blockHash, number: 100n })
  rpc.readContract.mockReset().mockResolvedValue(6)
})
const deposit = (address = owner, transactionHash = hash) =>
  creditDeposit({ credits, config, owner: address, transactionHash })

it('credits the exact matching token transfer once, even when the client retries', async () => {
  expect(await deposit()).toMatchObject({ points: 10000, balance: 10000 })
  await expect(deposit()).rejects.toBeInstanceOf(DuplicateDeposit)
  expect(await credits.balance(owner)).toBe(10000)
  expect(rpc.getTransactionReceipt).toHaveBeenCalledWith({ hash })
})

it('rejects treasury self-transfers before making an RPC request', async () => {
  await expect(deposit(`0x${'AB'.repeat(20)}`)).rejects.toMatchObject({
    code: 'DEPOSIT_SELF_TRANSFER',
  })
  expect(rpc.getTransactionReceipt).not.toHaveBeenCalled()
  expect(rpc.getChainId).not.toHaveBeenCalled()
  expect(await credits.balance(treasury)).toBe(0)
})

it('refuses a mismatched or unreadable RPC network before reading any receipt', async () => {
  rpc.getChainId.mockResolvedValueOnce(56)
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_NETWORK_MISMATCH' })
  rpc.getChainId.mockRejectedValueOnce(new Error('RPC unavailable'))
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_NETWORK_UNAVAILABLE' })
  expect(rpc.getTransactionReceipt).not.toHaveBeenCalled()
  expect(await credits.balance(owner)).toBe(0)
})

it('waits for three confirmations and accepts a later retry of the same hash', async () => {
  rpc.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValueOnce(101n)
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING' })
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING' })
  expect(await credits.balance(owner)).toBe(0)
  expect(await deposit()).toMatchObject({ points: 10000, balance: 10000 })
})

it('does not credit when confirmation depth cannot be established', async () => {
  rpc.getBlockNumber.mockRejectedValueOnce(new Error('RPC unavailable'))
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMATIONS_UNAVAILABLE' })
  rpc.getBlockNumber.mockResolvedValueOnce(99n)
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING' })
  expect(await credits.balance(owner)).toBe(0)
})

it('refuses malformed, missing, and reverted transactions without adding points', async () => {
  await expect(deposit(owner, '0xwrong')).rejects.toMatchObject({ code: 'DEPOSIT_MALFORMED' })
  expect(rpc.getTransactionReceipt).not.toHaveBeenCalled()
  rpc.getTransactionReceipt.mockRejectedValueOnce(new Error('Receipt missing'))
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_NOT_FOUND' })
  rpc.getTransactionReceipt.mockResolvedValueOnce(receipt([], 'reverted'))
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_REVERTED' })
  expect(await credits.balance(owner)).toBe(0)
})

it.each([{ from: other }, { to: other }, { address: other }])(
  'refuses the wrong receipt owner, recipient or token: %j',
  async (changes) => {
    rpc.getTransactionReceipt.mockResolvedValueOnce(receipt([transfer(changes)]))
    await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_NOT_YOURS' })
    expect(await credits.balance(owner)).toBe(0)
  },
)

it('sums only matching transfers and ignores unrelated logs in the same transaction', async () => {
  rpc.getTransactionReceipt.mockResolvedValueOnce(
    receipt([
      transfer({ amount: 1_000_000n }),
      transfer({ amount: 2_000_000n }),
      transfer({ from: other, amount: 90_000_000n }),
      transfer({ to: other, amount: 90_000_000n }),
      transfer({ address: other, amount: 90_000_000n }),
    ]),
  )
  expect(await deposit()).toMatchObject({ points: 30000, balance: 30000 })
})

it('credits mainnet USDT at eighteen decimals and records the payment network', async () => {
  const mainnet: DepositConfig = {
    ...config,
    chainId: 56,
    decimals: 18,
    token: '0x55d398326f99059ff775485246999027b3197955',
  }
  rpc.getChainId.mockResolvedValue(56)
  rpc.readContract.mockResolvedValue(18)
  rpc.getTransactionReceipt.mockResolvedValue(
    receipt([transfer({ address: mainnet.token, amount: 25n * 10n ** 17n + 1n })]),
  )
  expect(await creditDeposit({ credits, config: mainnet, owner, transactionHash: hash })).toEqual({
    points: 25_000,
    balance: 25_000,
    amount: '2.500000000000000001 USDT',
  })
  expect((await credits.history(owner))[0]).toMatchObject({
    reference: hash,
    detail: {
      chainId: 56,
      decimals: 18,
      token: mainnet.token,
      treasury,
      transactionHash: hash,
      baseUnits: '2500000000000000001',
    },
  })
})

it('preserves historical raw-hash replay protection across the network cutover', async () => {
  await credits.deposit({
    owner,
    points: 10_000,
    reason: 'deposit',
    reference: hash,
    detail: { chainId: 97, token, baseUnits: '1000000' },
  })
  await expect(deposit()).rejects.toBeInstanceOf(DuplicateDeposit)
  const mainnet: DepositConfig = {
    ...config,
    chainId: 56,
    decimals: 18,
    token: '0x55d398326f99059ff775485246999027b3197955',
  }
  rpc.getChainId.mockResolvedValue(56)
  rpc.readContract.mockResolvedValue(18)
  rpc.getTransactionReceipt.mockResolvedValue(
    receipt([transfer({ address: mainnet.token, amount: 10n ** 18n })]),
  )
  await expect(
    creditDeposit({ credits, config: mainnet, owner, transactionHash: hash }),
  ).rejects.toBeInstanceOf(DuplicateDeposit)
  expect(await credits.balance(owner)).toBe(10_000)
  expect((await credits.history(owner))[0]?.detail.chainId).toBe(97)
})

it('accepts only the requested receipt in its current canonical block', async () => {
  rpc.getTransactionReceipt.mockResolvedValueOnce({
    ...receipt(),
    transactionHash: `0x${'01'.repeat(32)}`,
  })
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_RECEIPT_INVALID' })
  rpc.getBlock.mockResolvedValueOnce({ hash: `0x${'02'.repeat(32)}` })
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING' })
  rpc.getBlock.mockRejectedValueOnce(new Error('secret-rpc-key'))
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMATIONS_UNAVAILABLE' })
  expect(await credits.balance(owner)).toBe(0)
})

it('rejects token decimal mismatch before reading any payment', async () => {
  rpc.readContract.mockResolvedValueOnce(18)
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_TOKEN_MISMATCH' })
  expect(rpc.getTransactionReceipt).not.toHaveBeenCalled()
  expect(await credits.balance(owner)).toBe(0)
})

it('credits concurrent retries and differently cased hashes at most once', async () => {
  const casedHash = `0x${'aB'.repeat(32)}`
  rpc.getTransactionReceipt.mockResolvedValue({
    ...receipt(),
    transactionHash: casedHash.toLowerCase(),
  })
  const results = await Promise.allSettled([
    deposit(owner, casedHash),
    deposit(owner, casedHash.toLowerCase()),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
    { reason: expect.any(DuplicateDeposit) },
  ])
  expect(await credits.balance(owner)).toBe(10_000)
})

function finalizedDeposit(finalized: unknown) {
  const mainnet: DepositConfig = {
    ...config,
    chainId: 56,
    decimals: 18,
    token: '0x55d398326f99059ff775485246999027b3197955',
  }
  rpc.getChainId.mockResolvedValue(56)
  rpc.readContract.mockResolvedValue(18)
  rpc.getTransactionReceipt.mockResolvedValue(
    receipt([transfer({ address: mainnet.token, amount: 10n ** 18n })]),
  )
  rpc.getBlock.mockImplementation(async ({ blockTag }) =>
    blockTag === 'finalized' ? finalized : { hash: blockHash, number: 100n },
  )
  return () => creditDeposit({ credits, config: mainnet, owner, transactionHash: hash })
}

it('does not credit mainnet while economic finality is behind, even with a far newer head', async () => {
  const pay = finalizedDeposit({ hash: `0x${'89'.repeat(32)}`, number: 99n })
  rpc.getBlockNumber.mockResolvedValue(100_000n)
  await expect(pay()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING', statusCode: 409 })
  expect(rpc.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
  expect(await credits.balance(owner)).toBe(0)
  expect(await credits.history(owner)).toEqual([])
})

it.each([100n, 101n])(
  'credits mainnet only when economic finality reaches block %s',
  async (number) => {
    const pay = finalizedDeposit({ hash: blockHash, number })
    expect(await pay()).toMatchObject({ points: 10_000, balance: 10_000 })
    expect(rpc.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
    expect(rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
    await expect(pay()).rejects.toBeInstanceOf(DuplicateDeposit)
    expect(await credits.balance(owner)).toBe(10_000)
  },
)

it.each([
  null,
  undefined,
  {},
  { hash: blockHash, number: null },
  { hash: blockHash, number: 100 },
  { hash: blockHash, number: '100' },
  { hash: blockHash, number: 'not-a-height' },
  { hash: blockHash, number: -1n },
  { number: 100n },
  { hash: null, number: 100n },
  { hash: '0xmalformed', number: 100n },
  { hash: `0x${'00'.repeat(32)}`, number: 100n },
])('does not credit mainnet from malformed finalized data, case %#', async (finalized) => {
  await expect(finalizedDeposit(finalized)()).rejects.toMatchObject({
    code: 'DEPOSIT_CONFIRMATIONS_UNAVAILABLE',
    statusCode: 503,
  })
  expect(await credits.balance(owner)).toBe(0)
  expect(await credits.history(owner)).toEqual([])
})

it('fails closed when mainnet RPC does not support finalized blocks', async () => {
  const pay = finalizedDeposit({ hash: blockHash, number: 100n })
  rpc.getBlock.mockImplementation(async ({ blockTag }) => {
    if (blockTag === 'finalized') throw new Error('Unsupported finalized tag at secret-rpc-key')
    return { hash: blockHash, number: 100n }
  })
  await expect(pay()).rejects.toMatchObject({
    code: 'DEPOSIT_CONFIRMATIONS_UNAVAILABLE',
    statusCode: 503,
  })
  expect(await credits.balance(owner)).toBe(0)
  expect(await credits.history(owner)).toEqual([])
})

it('checks the canonical payment block after the finalized head, so an intervening reorg cannot credit', async () => {
  const pay = finalizedDeposit({ hash: blockHash, number: 101n })
  let finalityRead = false
  rpc.getBlock.mockImplementation(async ({ blockTag }) => {
    if (blockTag === 'finalized') {
      finalityRead = true
      return { hash: `0x${'91'.repeat(32)}`, number: 101n }
    }
    return { hash: finalityRead ? `0x${'92'.repeat(32)}` : blockHash, number: 100n }
  })
  await expect(pay()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING', statusCode: 409 })
  expect(rpc.getBlock.mock.calls.map(([input]) => input)).toEqual([
    { blockTag: 'finalized' },
    { blockNumber: 100n },
  ])
  expect(await credits.balance(owner)).toBe(0)
  expect(await credits.history(owner)).toEqual([])
})

it('does not accept a different finalized block at the same height as the receipt', async () => {
  const pay = finalizedDeposit({ hash: `0x${'91'.repeat(32)}`, number: 100n })
  await expect(pay()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING', statusCode: 409 })
  expect(await credits.balance(owner)).toBe(0)
  expect(await credits.history(owner)).toEqual([])
})

it('keeps testnet on the existing confirmation policy without requiring finalized support', async () => {
  rpc.getBlock.mockImplementation(async ({ blockTag }) => {
    if (blockTag === 'finalized') throw new Error('Unsupported finalized tag')
    return { hash: blockHash, number: 100n }
  })
  rpc.getBlockNumber.mockResolvedValueOnce(101n)
  await expect(deposit()).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING' })
  expect(await deposit()).toMatchObject({ points: 10_000, balance: 10_000 })
  expect(rpc.getBlock).not.toHaveBeenCalledWith({ blockTag: 'finalized' })
})
