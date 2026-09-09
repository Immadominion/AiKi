import type { PublicClient } from 'viem'
import { expect, it, vi } from 'vitest'
import { createWatchActivationReader } from './routes.js'

const ACCOUNT = `0x${'aa'.repeat(20)}` as const
const MARKET = `0x${'bb'.repeat(20)}` as const
const TOKEN = `0x${'cc'.repeat(20)}` as const
const ORACLE = `0x${'dd'.repeat(20)}` as const
const WAD = 10n ** 18n

it('exposes only the configured public executor address for activation checks', () => {
  const rpc = client()
  const verifyMandate = vi.fn(async () => ({ ready: true as const }))
  const reader = createWatchActivationReader(
    'http://127.0.0.1:1',
    rpc as unknown as PublicClient,
    56,
    ACCOUNT,
    verifyMandate,
  )
  expect(reader.executorAddress).toBe(ACCOUNT)
  expect(reader.verifyMandate).toBe(verifyMandate)
  expect(verifyMandate).not.toHaveBeenCalled()
  expect(reader).not.toHaveProperty('agentKey')
  expect(reader).not.toHaveProperty('privateKey')
  expect(rpc.readContract).not.toHaveBeenCalled()
})

function client() {
  const getChainId = vi.fn(async () => 97)
  const readContract = vi.fn(async (request: { functionName: string }) => {
    switch (request.functionName) {
      case 'getAccountLiquidity':
        return [0n, 0n, 0n]
      case 'getAssetsIn':
        return [MARKET]
      case 'oracle':
        return ORACLE
      case 'markets':
        return [true, 0n, true, 0n]
      case 'getAccountSnapshot':
        return [0n, 0n, 5n, WAD]
      case 'getUnderlyingPrice':
        return WAD
      case 'underlying':
        return TOKEN
      default:
        throw new Error(`Unexpected read: ${request.functionName}`)
    }
  })
  return { getChainId, readContract }
}

it('uses the existing Venus snapshot and reads the actual ERC-20 market underlying on testnet', async () => {
  const rpc = client()
  const reader = createWatchActivationReader(
    'http://127.0.0.1:1',
    rpc as unknown as PublicClient,
    97,
  )
  expect(reader.chainId).toBe(97)
  const snapshot = await reader.snapshot(ACCOUNT)
  expect(snapshot.account).toBe(ACCOUNT)
  expect(snapshot.markets[0]?.borrowBalance).toBe(5n)
  expect(await reader.underlying(MARKET)).toBe(TOKEN)
  expect(rpc.getChainId).toHaveBeenCalledTimes(2)
  expect(rpc.readContract).toHaveBeenCalledWith(
    expect.objectContaining({
      address: MARKET,
      functionName: 'underlying',
    }),
  )
  expect(rpc.readContract).toHaveBeenCalledWith(
    expect.objectContaining({
      address: MARKET,
      functionName: 'getAccountSnapshot',
      args: [ACCOUNT],
    }),
  )
})

it('rejects a misconfigured mainnet RPC before reading balances or token identity', async () => {
  const rpc = client()
  rpc.getChainId.mockResolvedValue(56)
  const reader = createWatchActivationReader(
    'http://127.0.0.1:1',
    rpc as unknown as PublicClient,
    97,
  )
  await expect(reader.snapshot(ACCOUNT)).rejects.toThrow('execution network')
  await expect(reader.underlying(MARKET)).rejects.toThrow('execution network')
  expect(rpc.readContract).not.toHaveBeenCalled()
})

it('does not invent an underlying when a market cannot answer', async () => {
  const rpc = client()
  rpc.readContract.mockRejectedValue(new Error('market unavailable'))
  const reader = createWatchActivationReader(
    'http://127.0.0.1:1',
    rpc as unknown as PublicClient,
    97,
  )
  await expect(reader.underlying(MARKET)).rejects.toThrow('market unavailable')
})

it('reads mainnet Venus on chain56 without treating its RPC as testnet', async () => {
  const rpc = client()
  rpc.getChainId.mockResolvedValue(56)
  const reader = createWatchActivationReader(
    'http://127.0.0.1:1',
    rpc as unknown as PublicClient,
    56,
  )
  expect(reader.chainId).toBe(56)
  expect((await reader.snapshot(ACCOUNT)).account).toBe(ACCOUNT)
  expect(await reader.underlying(MARKET)).toBe(TOKEN)
  expect(rpc.readContract).toHaveBeenCalledWith(
    expect.objectContaining({
      address: '0xfD36E2c2a6789Db23113685031d7F16329158384',
      functionName: 'getAssetsIn',
    }),
  )
})
