import type postgres from 'postgres'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DepositConfig } from './deposit.js'
import { checkCreditLedger, historicalCreditNetworks } from './reconcile-backing.js'

const mocks = vi.hoisted(() => ({
  mainnet: { getChainId: vi.fn(), readContract: vi.fn() },
  testnet: { getChainId: vi.fn(), readContract: vi.fn() },
  checkLedger: vi.fn(),
  begin: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(({ chain }) => (chain.id === 56 ? mocks.mainnet : mocks.testnet)),
}))
vi.mock('./reconcile.js', () => ({ checkLedger: mocks.checkLedger }))

const treasury = `0x${'ab'.repeat(20)}` as const
const historicalEnv = {
  CREDITS_HISTORICAL_CHAIN_ID: '97',
  CREDITS_HISTORICAL_TREASURY_ADDRESS: treasury,
  CREDITS_HISTORICAL_RPC_URL: 'http://127.0.0.1:1/old-rail',
}
const current: DepositConfig = {
  chainId: 56,
  token: '0x55d398326f99059ff775485246999027b3197955',
  treasury,
  decimals: 18,
  rpcUrl: 'http://127.0.0.1:1/current-rail',
}
const snapshot = { readonly: true }
const sql = { begin: mocks.begin } as unknown as postgres.Sql

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mainnet.getChainId.mockReset().mockResolvedValue(56)
  mocks.testnet.getChainId.mockReset().mockResolvedValue(97)
  mocks.mainnet.readContract
    .mockReset()
    .mockImplementation(async ({ functionName }) =>
      functionName === 'decimals' ? 18 : 2n * 10n ** 18n,
    )
  mocks.testnet.readContract
    .mockReset()
    .mockImplementation(async ({ functionName }) => (functionName === 'decimals' ? 6 : 3_000_000n))
  mocks.begin.mockImplementation(async (_options, run) => run(snapshot))
  mocks.checkLedger.mockResolvedValue([{ check: 'fixture', ok: true, detail: 'read only' }])
})

describe('explicit historical payment observation configuration', () => {
  it('does not infer a historical rail from the current execution or payment environment', () => {
    expect(
      historicalCreditNetworks({
        CREDITS_CHAIN_ID: '56',
        CREDITS_TREASURY_ADDRESS: treasury,
        CREDITS_RPC_URL: 'http://127.0.0.1:1/current-rail',
        ENFORCER_RPC_URL: 'http://127.0.0.1:1/execution-rail',
      }),
    ).toEqual([])
  })

  it('pins the original testnet asset and decimals while retaining the explicit old treasury/RPC', () => {
    const [config] = historicalCreditNetworks(historicalEnv)
    expect(config).toMatchObject({
      chainId: 97,
      decimals: 6,
      treasury,
      rpcUrl: historicalEnv.CREDITS_HISTORICAL_RPC_URL,
    })
    expect(config?.token.toLowerCase()).toBe('0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c')
  })

  it.each([
    { CREDITS_HISTORICAL_CHAIN_ID: '97' },
    { ...historicalEnv, CREDITS_HISTORICAL_CHAIN_ID: '98' },
    {
      ...historicalEnv,
      CREDITS_HISTORICAL_RPC_URL: undefined,
      CREDITS_RPC_URL: 'http://127.0.0.1:1',
    },
    {
      ...historicalEnv,
      CREDITS_HISTORICAL_TREASURY_ADDRESS: undefined,
      CREDITS_TREASURY_ADDRESS: treasury,
    },
    { ...historicalEnv, CREDITS_HISTORICAL_TOKEN_ADDRESS: current.token },
    { ...historicalEnv, CREDITS_HISTORICAL_RPC_URL: 'file:///private/config' },
    { ...historicalEnv, CREDITS_HISTORICAL_TREASURY_ADDRESS: `0x${'0'.repeat(40)}` },
  ])('rejects incomplete or wrong historical configuration without fallback: %j', (env) => {
    expect(() => historicalCreditNetworks(env)).toThrow()
  })

  it('pins mainnet history separately to mainnet USDT and eighteen decimals', () => {
    expect(
      historicalCreditNetworks({ ...historicalEnv, CREDITS_HISTORICAL_CHAIN_ID: '56' })[0],
    ).toMatchObject({
      chainId: 56,
      token: current.token,
      decimals: 18,
    })
    expect(() =>
      historicalCreditNetworks({
        ...historicalEnv,
        CREDITS_HISTORICAL_CHAIN_ID: '56',
        CREDITS_HISTORICAL_TOKEN_ADDRESS: '0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c',
      }),
    ).toThrow()
  })
})

describe('fresh, independently verified backing snapshots', () => {
  it('checks both networks and token decimals, then sends separate amounts into one read-only snapshot', async () => {
    const historical = historicalCreditNetworks(historicalEnv)
    await expect(checkCreditLedger(sql, current, historical)).resolves.toEqual([
      { check: 'fixture', ok: true, detail: 'read only' },
    ])
    expect(mocks.begin).toHaveBeenCalledWith(
      'isolation level repeatable read read only',
      expect.any(Function),
    )
    expect(mocks.checkLedger).toHaveBeenCalledWith(snapshot, 20_000, current, [
      {
        chainId: 97,
        token: historical[0]?.token,
        treasury,
        backingPoints: 30_000,
      },
    ])
    for (const rpc of [mocks.mainnet, mocks.testnet]) {
      expect(rpc.getChainId).toHaveBeenCalledOnce()
      expect(rpc.readContract.mock.calls.map(([input]) => input.functionName)).toEqual([
        'decimals',
        'balanceOf',
      ])
    }
    // No cache of a prior successful observation may conceal a subsequent outage.
    mocks.testnet.getChainId.mockRejectedValueOnce(new Error('credential must not escape'))
    await checkCreditLedger(sql, current, historical)
    expect(mocks.checkLedger.mock.lastCall?.[3][0].backingPoints).toBeNull()
  })

  it.each(['chain', 'decimals', 'unavailable'])(
    'keeps old-rail backing unverified on %s failure without borrowing the mainnet balance',
    async (failure) => {
      if (failure === 'chain') mocks.testnet.getChainId.mockResolvedValueOnce(56)
      if (failure === 'decimals') mocks.testnet.readContract.mockResolvedValueOnce(18)
      if (failure === 'unavailable')
        mocks.testnet.readContract.mockRejectedValueOnce(new Error('private RPC credential'))
      await checkCreditLedger(sql, current, historicalCreditNetworks(historicalEnv))
      expect(mocks.checkLedger.mock.lastCall?.[1]).toBe(20_000)
      expect(mocks.checkLedger.mock.lastCall?.[3][0].backingPoints).toBeNull()
      expect(
        mocks.testnet.readContract.mock.calls.some(([input]) => input.functionName === 'balanceOf'),
      ).toBe(false)
    },
  )

  it('does not substitute historical backing when the current rail is unavailable or unconfigured', async () => {
    mocks.mainnet.getChainId.mockResolvedValueOnce(97)
    await checkCreditLedger(sql, current, historicalCreditNetworks(historicalEnv))
    expect(mocks.checkLedger.mock.lastCall?.[1]).toBeNull()
    expect(mocks.checkLedger.mock.lastCall?.[3][0].backingPoints).toBe(30_000)
    await checkCreditLedger(sql, undefined, historicalCreditNetworks(historicalEnv))
    expect(mocks.checkLedger.mock.lastCall?.[1]).toBeNull()
    expect(mocks.checkLedger.mock.lastCall?.[2]).toBeUndefined()
  })
})
