import { parseSiweMessage } from 'viem/siwe'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AikiClient } from './client.js'
import { balanceOf, type Identity, signIn } from './identity.js'

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBalance: vi.fn() }))
const fs = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}))
vi.mock('node:fs', () => fs)
vi.mock('viem/accounts', () => ({ generatePrivateKey: vi.fn(), privateKeyToAccount: vi.fn() }))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => rpc),
}))
const address = `0x${'12'.repeat(20)}` as const
const signMessage = vi.fn()
const identity = { account: { address, signMessage }, source: 'environment' } as unknown as Identity
let returnedChain: number
let returnedAddress: string
beforeEach(() => {
  returnedChain = 56
  returnedAddress = address
  signMessage.mockReset().mockResolvedValue('0xmock-signature')
  rpc.getChainId.mockReset().mockResolvedValue(56)
  rpc.getBalance.mockReset().mockResolvedValue(2n * 10n ** 18n)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname
      if (path === '/v1/auth/nonce') return new Response(JSON.stringify({ nonce: 'a1b2c3d4' }))
      if (path === '/v1/auth/verify')
        return new Response(JSON.stringify({ address: returnedAddress, chainId: returnedChain }), {
          headers: { 'set-cookie': 'aiki_session=mocked; Path=/' },
        })
      throw new Error('Unexpected mocked request.')
    }),
  )
})
afterEach(() => {
  expect(fs.readFileSync).not.toHaveBeenCalled()
  expect(fs.writeFileSync).not.toHaveBeenCalled()
  expect(fs.mkdirSync).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

it.each([56, 97] as const)(
  'binds the SIWE signature and checked auth response to chain %s',
  async (chainId) => {
    returnedChain = chainId
    const client = new AikiClient('https://mocked-api.test')
    await expect(signIn(client, identity, 'aiki.test', chainId)).resolves.toEqual({
      address,
      chainId,
    })
    expect(parseSiweMessage(signMessage.mock.calls[0]?.[0].message).chainId).toBe(chainId)
    expect(client.signedIn).toBe(true)
  },
)

it.each(['chain', 'address'])('discards a mismatched sign-in response: %s', async (field) => {
  if (field === 'chain') returnedChain = 97
  else returnedAddress = `0x${'34'.repeat(20)}`
  const client = new AikiClient('https://mocked-api.test')
  await expect(signIn(client, identity, 'aiki.test', 56)).rejects.toThrow('does not match')
  expect(client.signedIn).toBe(false)
})

it.each([56, 97] as const)('labels native balances from actual RPC chain %s', async (chainId) => {
  rpc.getChainId.mockResolvedValue(chainId)
  const result = await balanceOf('https://mocked-rpc.test', address)
  expect(result).toEqual({
    amount: '2',
    chainId,
    network: chainId === 56 ? 'mainnet' : 'testnet',
    symbol: chainId === 56 ? 'BNB' : 'tBNB',
  })
  expect(rpc.getChainId.mock.invocationCallOrder[0]).toBeLessThan(
    rpc.getBalance.mock.invocationCallOrder[0] ?? 0,
  )
})

it('refuses an unsupported or unreadable wallet RPC instead of calling its balance BNB', async () => {
  rpc.getChainId.mockResolvedValueOnce(1)
  await expect(balanceOf('https://mocked-rpc.test', address)).rejects.toThrow('not a supported')
  rpc.getChainId.mockRejectedValueOnce(new Error('RPC unavailable'))
  await expect(balanceOf('https://mocked-rpc.test', address)).rejects.toThrow('RPC unavailable')
  expect(rpc.getBalance).not.toHaveBeenCalled()
})
