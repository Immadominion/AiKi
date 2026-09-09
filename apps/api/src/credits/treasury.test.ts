import { beforeEach, expect, it, vi } from 'vitest'
import type { DepositConfig } from './deposit.js'
import { treasuryBackingPoints } from './treasury.js'

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), readContract: vi.fn() }))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => rpc),
}))
const config: DepositConfig = {
  chainId: 56,
  decimals: 18,
  token: '0x55d398326f99059ff775485246999027b3197955',
  treasury: `0x${'ab'.repeat(20)}`,
  rpcUrl: 'http://127.0.0.1:1',
}
beforeEach(() => {
  rpc.getChainId.mockReset().mockResolvedValue(56)
  rpc.readContract
    .mockReset()
    .mockImplementation(async ({ functionName }) =>
      functionName === 'decimals' ? 18 : 25n * 10n ** 17n,
    )
})

it('converts the verified mainnet treasury balance using eighteen decimals', async () => {
  expect(await treasuryBackingPoints(config)).toBe(25_000)
  expect(rpc.readContract.mock.calls.map(([input]) => input.functionName)).toEqual([
    'decimals',
    'balanceOf',
  ])
})

it('keeps historical six-decimal backing correctly denominated', async () => {
  rpc.getChainId.mockResolvedValue(97)
  rpc.readContract.mockImplementation(async ({ functionName }) =>
    functionName === 'decimals' ? 6 : 2_500_000n,
  )
  expect(await treasuryBackingPoints({ ...config, chainId: 97, decimals: 6 })).toBe(25_000)
})

it('does not count backing on a mismatched or unavailable network', async () => {
  rpc.getChainId.mockResolvedValueOnce(97)
  expect(await treasuryBackingPoints(config)).toBeNull()
  expect(rpc.readContract).not.toHaveBeenCalled()
  rpc.getChainId.mockRejectedValueOnce(new Error('secret-rpc-key'))
  expect(await treasuryBackingPoints(config)).toBeNull()
  expect(await treasuryBackingPoints(undefined)).toBeNull()
})

it('does not count unverifiable decimals, unreadable balances, or unsafe point amounts', async () => {
  rpc.readContract.mockResolvedValueOnce(6)
  expect(await treasuryBackingPoints(config)).toBeNull()
  rpc.readContract.mockRejectedValueOnce(new Error('secret-rpc-key'))
  expect(await treasuryBackingPoints(config)).toBeNull()
  rpc.readContract.mockResolvedValueOnce(18).mockRejectedValueOnce(new Error('balance unavailable'))
  expect(await treasuryBackingPoints(config)).toBeNull()
  rpc.readContract
    .mockResolvedValueOnce(18)
    .mockResolvedValueOnce((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 10n ** 14n)
  expect(await treasuryBackingPoints(config)).toBeNull()
})
