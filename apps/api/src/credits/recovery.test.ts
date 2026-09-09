import type postgres from 'postgres'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DepositConfig } from './deposit.js'
import { type RecoveryEntry, recoveryInput, reviewHistoricalDeposit } from './recovery.js'
import { ISSUANCE_ACCOUNT } from './store.js'

const rpc = vi.hoisted(() => ({
  getChainId: vi.fn(),
  readContract: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockNumber: vi.fn(),
  getBlock: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => rpc),
}))
const { parseAbiItem, toEventSelector } = await import('viem')
const event = toEventSelector(
  parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
)
const owner = `0x${'12'.repeat(20)}`
const treasury = `0x${'ab'.repeat(20)}` as const
const token = '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c' as const
const hash = `0x${'ef'.repeat(32)}`
const blockHash = `0x${'90'.repeat(32)}`
const config: DepositConfig = {
  chainId: 97,
  decimals: 6,
  token,
  treasury,
  rpcUrl: 'http://127.0.0.1:1',
}
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const receipt = (asset = token as string, units = 1_000_000n) => ({
  status: 'success',
  transactionHash: hash,
  blockHash,
  blockNumber: 100n,
  logs: [
    {
      address: asset,
      topics: [event, topic(owner), topic(treasury)],
      data: `0x${units.toString(16).padStart(64, '0')}`,
    },
  ],
})
let entries: RecoveryEntry[]
const read = vi.fn()
const begin = vi.fn()
const sql = { begin } as unknown as postgres.Sql
const review = (rail = config) =>
  reviewHistoricalDeposit({ sql, config: rail, owner, transactionHash: hash })
const recorded = (): RecoveryEntry[] => [
  {
    id: 'payer-entry',
    owner,
    delta: '10000',
    reason: 'deposit',
    reference: hash,
    detail: { chainId: 97, token, baseUnits: '1000000' },
  },
  {
    id: 'issuance-entry',
    owner: ISSUANCE_ACCOUNT,
    delta: '-10000',
    reason: 'deposit',
    reference: `${hash}:src`,
    detail: { issuedTo: owner },
  },
]
beforeEach(() => {
  entries = []
  rpc.getChainId.mockReset().mockResolvedValue(97)
  rpc.readContract.mockReset().mockResolvedValue(6)
  rpc.getTransactionReceipt.mockReset().mockResolvedValue(receipt())
  rpc.getBlockNumber.mockReset().mockResolvedValue(102n)
  rpc.getBlock.mockReset().mockResolvedValue({ hash: blockHash, number: 100n })
  read.mockReset().mockImplementation(async () => structuredClone(entries))
  begin.mockReset().mockImplementation(async (options, action) => {
    expect(options).toBe('isolation level repeatable read read only')
    return action(read)
  })
})

it('returns a verified historical recovery candidate using only a read-only ledger snapshot', async () => {
  const result = await review()
  expect(result).toMatchObject({
    status: 'verified_uncredited',
    applied: false,
    points: 10000,
    amount: '1 USDT',
    transactionHash: hash,
    payment: { chainId: 97, decimals: 6, token: token.toLowerCase(), treasury },
  })
  expect(result.note).toContain('No points were issued')
  expect(result).not.toHaveProperty('balance')
  expect(entries).toEqual([])
  expect(begin).toHaveBeenCalledOnce()
  const statement = ((read.mock.calls[0]?.[0] ?? []) as readonly string[]).join('?')
  expect(statement).toMatch(/^\s*SELECT/)
  expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i)
  expect(statement).toContain("detail->>'repairs'")
})

it('recognizes both historical issuance formats without rewriting metadata or points', async () => {
  entries = recorded()
  const before = structuredClone(entries)
  expect(await review()).toMatchObject({ status: 'already_credited', applied: false })
  expect(entries).toEqual(before)
  entries[1] = {
    ...(before[1] as RecoveryEntry),
    reference: 'repair:payer-entry',
    detail: { repairs: 'payer-entry' },
  }
  expect(await review()).toMatchObject({ status: 'already_credited', applied: false })
})

it.each([
  'owner',
  'chain',
  'token',
  'points',
  'treasury',
  'missing_source',
  'orphan_source',
  'duplicate',
])('refuses an occupied original hash with conflicting history: %s', async (kind) => {
  entries = recorded()
  const payer = entries[0] as RecoveryEntry
  if (kind === 'owner') payer.owner = treasury
  if (kind === 'chain') payer.detail.chainId = 56
  if (kind === 'token') payer.detail.token = treasury
  if (kind === 'points') payer.delta = '5000'
  if (kind === 'treasury') payer.detail.treasury = owner
  if (kind === 'missing_source') entries = [payer]
  if (kind === 'orphan_source') entries = [entries[1] as RecoveryEntry]
  if (kind === 'duplicate') entries.push({ ...payer, id: 'second-payer' })
  const before = structuredClone(entries)
  const result = await review()
  expect(result.status).toBe('conflict')
  expect(result.applied).toBe(false)
  expect(entries).toEqual(before)
})

it('does not reinterpret a six-decimal historical payment as mainnet USDT', async () => {
  const mainnet: DepositConfig = {
    ...config,
    chainId: 56,
    decimals: 18,
    token: '0x55d398326f99059ff775485246999027b3197955',
  }
  await expect(review(mainnet)).rejects.toMatchObject({ code: 'DEPOSIT_NETWORK_MISMATCH' })
  expect(begin).not.toHaveBeenCalled()
})

it('uses the existing finalized and canonical-block checks when reviewing a mainnet payment', async () => {
  const mainnet: DepositConfig = {
    ...config,
    chainId: 56,
    decimals: 18,
    token: '0x55d398326f99059ff775485246999027b3197955',
  }
  rpc.getChainId.mockResolvedValue(56)
  rpc.readContract.mockResolvedValue(18)
  rpc.getTransactionReceipt.mockResolvedValue(receipt(mainnet.token, 10n ** 18n))
  rpc.getBlock.mockResolvedValueOnce({ hash: blockHash, number: 99n })
  await expect(review(mainnet)).rejects.toMatchObject({ code: 'DEPOSIT_CONFIRMING' })
  expect(begin).not.toHaveBeenCalled()
  expect(await review(mainnet)).toMatchObject({ status: 'verified_uncredited', points: 10000 })
  expect(rpc.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
  expect(rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
})

it('refuses treasury self-transfers before RPC or ledger access', async () => {
  await expect(
    reviewHistoricalDeposit({ sql, config, owner: treasury, transactionHash: hash }),
  ).rejects.toMatchObject({ code: 'DEPOSIT_SELF_TRANSFER' })
  expect(rpc.getChainId).not.toHaveBeenCalled()
  expect(begin).not.toHaveBeenCalled()
})

it('requires explicitly named historical rail, owner, original hash, and separate RPC configuration', () => {
  const values = { 'chain-id': '97', token, treasury, owner, 'transaction-hash': hash }
  expect(recoveryInput(values, config.rpcUrl)).toMatchObject({
    config: { chainId: 97, decimals: 6 },
    owner,
    transactionHash: hash,
  })
  expect(() => recoveryInput(values, undefined)).toThrow('no current-rail fallback')
  for (const field of ['chain-id', 'token', 'treasury', 'owner', 'transaction-hash'])
    expect(() => recoveryInput({ ...values, [field]: undefined }, config.rpcUrl)).toThrow()
  expect(() => recoveryInput(values, 'file:///sensitive')).toThrow('HTTP or HTTPS')
})
