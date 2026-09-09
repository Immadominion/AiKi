import { beforeEach, expect, it, vi } from 'vitest'
import { creditsNetwork, verifyCreditNetwork } from './credits-network.js'

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), readContract: vi.fn() }))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => rpc),
}))
const { createPublicClient } = await import('viem')
const treasury = `0x${'ab'.repeat(20)}`
const mainnetToken = '0x55d398326f99059ff775485246999027b3197955'
const mainnet = () => {
  const config = creditsNetwork({ CREDITS_CHAIN_ID: '56', CREDITS_TREASURY_ADDRESS: treasury })
  if (!config) throw new Error('Expected the configured treasury.')
  return config
}

beforeEach(() => {
  vi.clearAllMocks()
  rpc.getChainId.mockReset().mockResolvedValue(56)
  rpc.readContract.mockReset().mockResolvedValue(18)
})

it('selects explicit mainnet USDT and its decimals independently of execution settings', () => {
  const config = creditsNetwork({
    CREDITS_CHAIN_ID: '56',
    CREDITS_TREASURY_ADDRESS: treasury,
    CREDITS_RPC_URL: 'https://credits.example',
    ENFORCER_RPC_URL: 'https://testnet.example',
  })
  expect(config).toEqual({
    chainId: 56,
    decimals: 18,
    token: mainnetToken,
    treasury,
    rpcUrl: 'https://credits.example',
  })
  expect(mainnet()?.rpcUrl).not.toContain('prebsc')
})

it('keeps historical testnet configuration and leaves an absent treasury unavailable', () => {
  expect(creditsNetwork({})).toBeUndefined()
  expect(
    creditsNetwork({
      CREDITS_TREASURY_ADDRESS: treasury,
      ENFORCER_RPC_URL: 'https://mainnet.example',
    }),
  ).toMatchObject({
    chainId: 97,
    decimals: 6,
    token: '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c',
    rpcUrl: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  })
})

it('refuses ambiguous chains, invalid addresses, and a different mainnet token', () => {
  for (const chain of ['1', '56junk', ''])
    expect(() =>
      creditsNetwork({ CREDITS_CHAIN_ID: chain, CREDITS_TREASURY_ADDRESS: treasury }),
    ).toThrow()
  for (const address of ['0xwrong', `0x${'00'.repeat(20)}`])
    expect(() => creditsNetwork({ CREDITS_TREASURY_ADDRESS: address })).toThrow()
  expect(() =>
    creditsNetwork({
      CREDITS_CHAIN_ID: '56',
      CREDITS_TREASURY_ADDRESS: treasury,
      CREDITS_TOKEN_ADDRESS: treasury,
    }),
  ).toThrow()
  expect(() =>
    creditsNetwork({ CREDITS_TREASURY_ADDRESS: treasury, CREDITS_RPC_URL: 'file:///tmp/rpc' }),
  ).toThrow()
})

it('verifies actual RPC chain and token decimals with a bounded transport', async () => {
  const config = mainnet()
  await expect(verifyCreditNetwork(config)).resolves.toBeUndefined()
  expect(createPublicClient).toHaveBeenCalledWith(
    expect.objectContaining({ chain: expect.objectContaining({ id: 56 }) }),
  )
  expect(rpc.readContract).toHaveBeenCalledWith(
    expect.objectContaining({ address: mainnetToken, functionName: 'decimals' }),
  )
})

it('rejects a wrong chain before reading token metadata', async () => {
  rpc.getChainId.mockResolvedValue(97)
  await expect(verifyCreditNetwork(mainnet())).rejects.toMatchObject({
    code: 'DEPOSIT_NETWORK_MISMATCH',
    statusCode: 503,
  })
  expect(rpc.readContract).not.toHaveBeenCalled()
})

it('rejects token decimal disagreement and sanitizes upstream errors', async () => {
  rpc.readContract.mockResolvedValueOnce(6)
  await expect(verifyCreditNetwork(mainnet())).rejects.toMatchObject({
    code: 'DEPOSIT_TOKEN_MISMATCH',
    statusCode: 503,
  })
  rpc.readContract.mockRejectedValueOnce(new Error('secret-rpc-key'))
  await expect(verifyCreditNetwork(mainnet())).rejects.toMatchObject({
    code: 'DEPOSIT_TOKEN_UNAVAILABLE',
    statusCode: 503,
  })
  rpc.getChainId.mockRejectedValueOnce(new Error('secret-rpc-key'))
  await expect(verifyCreditNetwork(mainnet())).rejects.not.toThrow('secret-rpc-key')
})
