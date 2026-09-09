import { beforeEach, expect, it, vi } from 'vitest'
import { creditDeposit, type DepositConfig } from './deposit.js'
import { DuplicateDeposit, InMemoryCreditStore } from './store.js'

const rpc = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
  getChainId: vi.fn(),
  getBlockNumber: vi.fn(),
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
const config: DepositConfig = { rpcUrl: 'http://127.0.0.1:1', chainId: 97, treasury, token }
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const transfer = (
  options: { from?: string; to?: string; address?: string; amount?: bigint } = {},
) => ({
  address: options.address ?? token,
  topics: [TRANSFER, topic(options.from ?? owner), topic(options.to ?? treasury)],
  data: `0x${(options.amount ?? 1_000_000n).toString(16).padStart(64, '0')}`,
})
const receipt = (logs = [transfer()], status = 'success') => ({ status, logs, blockNumber: 100n })
let credits: InMemoryCreditStore
beforeEach(() => {
  credits = new InMemoryCreditStore()
  rpc.getTransactionReceipt.mockReset().mockResolvedValue(receipt())
  rpc.getChainId.mockReset().mockResolvedValue(97)
  rpc.getBlockNumber.mockReset().mockResolvedValue(102n)
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
