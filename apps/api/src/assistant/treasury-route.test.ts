import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DepositConfig } from '../credits/deposit.js'
import { InMemoryCreditStore } from '../credits/store.js'
import { createApiServer } from '../http/server.js'

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), readContract: vi.fn(), getBlock: vi.fn() }))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => rpc),
}))
const mainnet: DepositConfig = {
  chainId: 56,
  decimals: 18,
  token: '0x55d398326f99059ff775485246999027b3197955',
  treasury: `0x${'ab'.repeat(20)}`,
  rpcUrl: 'http://127.0.0.1:1',
}
const apps: ReturnType<typeof createApiServer>[] = []
beforeEach(() => {
  rpc.getChainId.mockReset().mockResolvedValue(56)
  rpc.readContract.mockReset().mockResolvedValue(18)
  rpc.getBlock.mockReset().mockResolvedValue({ number: 100n, hash: `0x${'90'.repeat(32)}` })
})
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
const harness = (deposits?: DepositConfig) => {
  const app = createApiServer({
    observations: () => [],
    assistant: {
      credits: new InMemoryCreditStore(),
      selfUrl: 'http://127.0.0.1:1',
      ...(deposits ? { deposits } : {}),
    },
  })
  apps.push(app)
  return () => app.inject({ method: 'GET', url: '/v1/credits/treasury' })
}

it('publishes verified mainnet USDT metadata including eighteen decimals', async () => {
  const response = await harness(mainnet)()
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.json()).toEqual({
    chainId: 56,
    decimals: 18,
    token: mainnet.token,
    treasury: mainnet.treasury,
    pointsPerUsdt: 10000,
    confirmations: 3,
    finality: 'finalized',
  })
  expect(rpc.getChainId).toHaveBeenCalledOnce()
  expect(rpc.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
  expect(rpc.readContract).toHaveBeenCalledWith(
    expect.objectContaining({ functionName: 'decimals' }),
  )
})

it('publishes historical testnet metadata only after verifying that rail', async () => {
  rpc.getChainId.mockResolvedValue(97)
  rpc.readContract.mockResolvedValue(6)
  const response = await harness({
    ...mainnet,
    chainId: 97,
    decimals: 6,
    token: '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c',
  })()
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ chainId: 97, decimals: 6, finality: 'confirmations' })
  expect(rpc.getBlock).not.toHaveBeenCalled()
})

it('reports an unconfigured rail without contacting an RPC', async () => {
  const response = await harness()()
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ available: false })
  expect(rpc.getChainId).not.toHaveBeenCalled()
})

it('stops advertising a previously working rail when its RPC changes network', async () => {
  const get = harness(mainnet)
  expect((await get()).statusCode).toBe(200)
  rpc.getChainId.mockResolvedValue(97)
  const response = await get()
  expect(response.statusCode).toBe(503)
  expect(response.json()).toMatchObject({ error: { code: 'DEPOSIT_NETWORK_MISMATCH' } })
  expect(response.body).not.toContain(mainnet.treasury)
  expect(response.body).not.toContain(mainnet.token)
})

it('fails closed on decimal mismatch and sanitized upstream failures', async () => {
  const get = harness(mainnet)
  rpc.readContract.mockResolvedValueOnce(6)
  const mismatch = await get()
  expect(mismatch.statusCode).toBe(503)
  expect(mismatch.json()).toMatchObject({ error: { code: 'DEPOSIT_TOKEN_MISMATCH' } })
  rpc.getChainId.mockRejectedValueOnce(new Error('https://private-rpc/secret-key'))
  const unavailable = await get()
  expect(unavailable.statusCode).toBe(503)
  expect(unavailable.json()).toMatchObject({ error: { code: 'DEPOSIT_NETWORK_UNAVAILABLE' } })
  expect(unavailable.body).not.toContain('private-rpc')
  expect(unavailable.body).not.toContain('secret-key')
  expect(unavailable.body).not.toContain(mainnet.treasury)
})

it('stops advertising mainnet payment addresses when finalized-block support becomes unavailable', async () => {
  const get = harness(mainnet)
  expect((await get()).statusCode).toBe(200)
  rpc.getBlock.mockRejectedValueOnce(
    new Error('Unsupported finalized tag at private-rpc/secret-key'),
  )
  const response = await get()
  expect(response.statusCode).toBe(503)
  expect(response.json()).toMatchObject({ error: { code: 'DEPOSIT_CONFIRMATIONS_UNAVAILABLE' } })
  expect(response.body).not.toContain(mainnet.treasury)
  expect(response.body).not.toContain(mainnet.token)
  expect(response.body).not.toContain('secret-key')
  expect(response.body).not.toContain('private-rpc')
})

it.each([
  null,
  undefined,
  {},
  { number: '100', hash: `0x${'90'.repeat(32)}` },
  { number: -1n, hash: `0x${'90'.repeat(32)}` },
  { number: 100n },
  { number: 100n, hash: null },
  { number: 100n, hash: '0xmalformed' },
  { number: 100n, hash: `0x${'00'.repeat(32)}` },
])('withholds mainnet payment addresses for malformed finality marker, case %#', async (marker) => {
  rpc.getBlock.mockResolvedValueOnce(marker)
  const response = await harness(mainnet)()
  expect(response.statusCode).toBe(503)
  expect(response.json()).toMatchObject({ error: { code: 'DEPOSIT_CONFIRMATIONS_UNAVAILABLE' } })
  expect(response.body).not.toContain(mainnet.treasury)
  expect(response.body).not.toContain(mainnet.token)
})

it('accepts a readable finalized marker without requiring finality to reach the latest head', async () => {
  rpc.getBlock.mockResolvedValueOnce({ number: 0n, hash: `0x${'90'.repeat(32)}` })
  const response = await harness(mainnet)()
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ finality: 'finalized', treasury: mainnet.treasury })
})
