import {
  type Abi,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  keccak256,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { VerifiedStrategySnapshot } from '../snapshot.js'
import { snapshotFixture } from '../snapshot.test-support.js'
import { YIELD_RAY as R, YIELD_WAD as U } from './rates.js'
import {
  YIELD_READ_ADDRESSES as A,
  readYieldSnapshot,
  type YieldSnapshotConfig,
  YieldSnapshotUnavailable,
} from './snapshot.js'
import type { YieldAddress } from './types.js'

const addr = (s: string): YieldAddress => `0x${s.repeat(40)}`
const HASH = `0x${'a'.repeat(64)}` as const
const CODE = '0x6000' as const
const CODE_HASH = keccak256(CODE)
const BLOCK = 121_004_566n
const TIME = 1_000_000n
const aggregateAbi = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
])
vi.mock('../../config/deployments/bsc-mainnet.json', async (original) => {
  const data = await original<{ default: object }>(),
    { keccak256 } = await import('viem')
  return { default: { ...data.default, managerCodeHash: keccak256('0x6005') } }
})

function fixture() {
  const config: YieldSnapshotConfig = {
    vault: addr('1'),
    controller: addr('2'),
    policyHash: HASH,
    factory: { address: addr('3'), runtimeHash: CODE_HASH },
    multicallRuntimeHash: CODE_HASH,
    venusImplementation: { address: addr('4'), runtimeHash: CODE_HASH },
    aaveImplementation: { address: addr('5'), runtimeHash: CODE_HASH },
    aaveReceiptImplementation: { address: addr('6'), runtimeHash: CODE_HASH },
  }
  const values: Record<string, unknown> = {}
  const methods = new Map<string, { key: string; abi: Abi; functionName: string }>()
  const register = (key: string, target: YieldAddress, signature: string, result: unknown) => {
    const functionName = /^function\s+(\w+)\(/.exec(signature)?.[1]
    if (!functionName) throw new Error('Invalid test fixture signature')
    methods.set(`${target.toLowerCase()}:${toFunctionSelector(signature)}`, {
      key,
      abi: parseAbi([signature]),
      functionName,
    })
    values[key] = result
  }
  register('accrue', A.venus, 'function accrueInterest() returns(uint256)', 0n)
  register(
    'registered',
    config.factory.address,
    'function isVault(address) view returns(bool)',
    true,
  )
  const vaultValues: Record<string, readonly [string, unknown]> = {
    controller: ['address', config.controller],
    policyHash: ['bytes32', HASH],
    strategyKind: ['bytes32', keccak256(toHex('aiki.yield-allocation.v1'))],
    underlying: ['address', A.underlying],
    venus: ['address', A.venus],
    comptroller: ['address', A.comptroller],
    aavePool: ['address', A.aave],
    aaveProvider: ['address', A.aaveProvider],
    aaveDataProvider: ['address', A.aaveData],
    aaveReceipt: ['address', A.aaveReceipt],
    expiresAt: ['uint64', TIME + 86_400n],
    minInterval: ['uint32', 60],
    maxDeadlineDelay: ['uint32', 300],
    operationNonce: ['uint256', 2n],
    lastExecutionAt: ['uint256', 0n],
    paused: ['bool', false],
    fundedPrincipal: ['uint256', 1_000n * U],
    turnover: ['uint256', 0n],
    cumulativeLoss: ['uint256', 0n],
    managedIdle: ['uint256', 500n * U],
    managedVenusShares: ['uint256', 2_500_000_000n],
    managedAaveScaled: ['uint256', 0n],
  }
  for (const [name, [type, value]] of Object.entries(vaultValues))
    register(name, config.vault, `function ${name}() view returns(${type})`, value)
  register(
    'limits',
    config.vault,
    'function limits() view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint16)',
    [1_000n * U, 500n * U, 2_000n * U, 100n * U, 800n * U, 800n * U, U, 2n * U, 100],
  )
  register(
    'idleOrCash',
    A.underlying,
    'function balanceOf(address) view returns(uint256)',
    500n * U,
  )
  register('underlyingDecimals', A.underlying, 'function decimals() view returns(uint8)', 18)
  const venusValues: Record<string, readonly [string, string, unknown]> = {
    vUnderlying: ['underlying', 'address', A.underlying],
    vComptroller: ['comptroller', 'address', A.comptroller],
    vImplementation: ['implementation', 'address', config.venusImplementation.address],
    vModel: ['interestRateModel', 'address', addr('7')],
    vCash: ['getCash', 'uint256', 100_000n * U],
    vDebt: ['totalBorrows', 'uint256', 100_000n * U],
    vReserves: ['totalReserves', 'uint256', 0n],
    vFactor: ['reserveFactorMantissa', 'uint256', U / 10n],
    vRate: ['exchangeRateStored', 'uint256', 2n * 10n ** 26n],
    vSupply: ['totalSupply', 'uint256', 1_000_000_000_000_000n],
    vSupplyRate: ['supplyRatePerBlock', 'uint256', 562_500_000n],
    vDecimals: ['decimals', 'uint8', 8],
  }
  for (const [key, [name, type, value]] of Object.entries(venusValues))
    register(key, A.venus, `function ${name}() view returns(${type})`, value)
  register('vBalance', A.venus, 'function balanceOf(address) view returns(uint256)', 2_500_000_000n)
  register(
    'vListed',
    A.comptroller,
    'function markets(address) view returns(bool,uint256,bool,uint256,uint256,uint96,bool)',
    [true, 0n, false, 0n, 0n, 0n, false],
  )
  register('vPaused', A.comptroller, 'function protocolPaused() view returns(bool)', false)
  register(
    'vActionPaused',
    A.comptroller,
    'function actionPaused(address,uint8) view returns(bool)',
    false,
  )
  register(
    'vCap',
    A.comptroller,
    'function supplyCaps(address) view returns(uint256)',
    1_000_000n * U,
  )
  register('vFee', A.comptroller, 'function treasuryPercent() view returns(uint256)', 0n)
  register(
    'aUnderlying',
    A.aaveReceipt,
    'function UNDERLYING_ASSET_ADDRESS() view returns(address)',
    A.underlying,
  )
  register('aPool', A.aaveReceipt, 'function POOL() view returns(address)', A.aave)
  register('aDecimals', A.aaveReceipt, 'function decimals() view returns(uint8)', 18)
  register('aBalance', A.aaveReceipt, 'function scaledBalanceOf(address) view returns(uint256)', 0n)
  register(
    'aProvider',
    A.aave,
    'function ADDRESSES_PROVIDER() view returns(address)',
    A.aaveProvider,
  )
  register('aProviderPool', A.aaveProvider, 'function getPool() view returns(address)', A.aave)
  register(
    'aDataProvider',
    A.aaveData,
    'function ADDRESSES_PROVIDER() view returns(address)',
    A.aaveProvider,
  )
  register(
    'aTokens',
    A.aaveData,
    'function getReserveTokensAddresses(address) view returns(address,address,address)',
    [A.aaveReceipt, addr('0'), addr('9')],
  )
  register(
    'aConfig',
    A.aaveData,
    'function getReserveConfigurationData(address) view returns(uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)',
    [18n, 0n, 0n, 0n, 1_000n, true, true, false, true, false],
  )
  register('aPaused', A.aaveData, 'function getPaused(address) view returns(bool)', false)
  register('aCaps', A.aaveData, 'function getReserveCaps(address) view returns(uint256,uint256)', [
    0n,
    1_000_000n,
  ])
  register(
    'aData',
    A.aaveData,
    'function getReserveData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40)',
    [0n, 1n, 200_000n * U, 0n, 100_000n * U, (3375n * R) / 100_000n, 0n, 0n, 0n, R, R, TIME],
  )
  register(
    'aModel',
    A.aaveData,
    'function getInterestRateStrategyAddress(address) view returns(address)',
    addr('8'),
  )
  register(
    'aIndex',
    A.aave,
    'function getReserveNormalizedIncome(address) view returns(uint256)',
    R + 1n,
  )
  register(
    'aVirtual',
    A.aave,
    'function getVirtualUnderlyingBalance(address) view returns(uint128)',
    100_000n * U,
  )
  const order: string[] = []
  const behavior = { trailingVenusPadding: true, failedLeg: '', truncate: false }
  const client = {
    getChainId: vi.fn(async () => 56),
    getBlock: vi.fn(async () => ({ number: BLOCK, hash: HASH as Hex, timestamp: TIME })),
    getBytecode: vi.fn(
      async (_input?: { address: YieldAddress; blockNumber: bigint }) => CODE as Hex,
    ),
    getStorageAt: vi.fn(async ({ address }: { address: YieldAddress }) =>
      pad(
        address === A.aave
          ? config.aaveImplementation.address
          : config.aaveReceiptImplementation.address,
      ),
    ),
    call: vi.fn(
      async ({ to, data, blockNumber }: { to: YieldAddress; data: Hex; blockNumber: bigint }) => {
        expect(blockNumber).toBe(BLOCK)
        if (to !== A.multicall)
          return {
            data: encodeFunctionResult({
              abi: parseAbi(['function testRate() view returns(uint256)']),
              functionName: 'testRate',
              result: 1n,
            }),
          }
        const decoded = decodeFunctionData({ abi: aggregateAbi, data })
        const legs = decoded.args[0].map((leg) => {
          expect(leg.allowFailure).toBe(false)
          const method = methods.get(`${leg.target.toLowerCase()}:${leg.callData.slice(0, 10)}`)
          if (!method) throw new Error('Unknown test fixture method')
          order.push(method.key)
          if (method.key !== 'accrue') expect(order[0]).toBe('accrue')
          let returnData = encodeFunctionResult({
            abi: method.abi,
            functionName: method.functionName,
            result: values[method.key],
          })
          if (method.key === 'vBalance' && behavior.trailingVenusPadding)
            returnData = `${returnData}${'0'.repeat(128)}`
          return { success: method.key !== behavior.failedLeg, returnData }
        })
        if (behavior.truncate) legs.pop()
        return {
          data: encodeFunctionResult({
            abi: aggregateAbi,
            functionName: 'aggregate3',
            result: legs,
          }),
        }
      },
    ),
  }
  // Only the read methods used by the production reader are mocked; no wallet or send method exists.
  const readClient = client as unknown as Parameters<typeof readYieldSnapshot>[0]
  return { config, values, client, readClient, order, behavior }
}

describe('verified same-block yield reader', () => {
  async function pinnedFixture() {
    const f = fixture(),
      sf = snapshotFixture('yield', {
        timestamp: TIME,
        blockNumber: BLOCK,
        blockHash: HASH,
        binding: { policyHash: HASH },
      })
    const proof = await sf.run()
    if (proof.status !== 'verified') throw new Error('Invalid strategy snapshot fixture')
    f.config.factory.runtimeHash = proof.snapshot.factory.runtimeCodeHash
    f.client.getBytecode.mockImplementation(async (input) =>
      input?.address === f.config.factory.address ? '0x6001' : CODE,
    )
    return { ...f, proof: proof.snapshot }
  }
  it('pins yield accounting to the verified custody block even after finalized head advances', async () => {
    const f = await pinnedFixture()
    f.client.getBlock.mockResolvedValueOnce({
      number: BLOCK + 2n,
      hash: keccak256('0x02'),
      timestamp: TIME + 1n,
    })
    const result = await readYieldSnapshot(f.readClient, f.config, {}, f.proof)
    expect(result.block.number).toBe(BLOCK)
    expect(result.block.hash).toBe(HASH)
    expect(f.client.getBlock.mock.calls).toEqual([
      [{ blockTag: 'finalized' }],
      [{ blockNumber: BLOCK }],
      [{ blockNumber: BLOCK }],
    ])
  })
  it('rejects a serialized or forged custody proof before accounting reads', async () => {
    const f = await pinnedFixture()
    await expect(
      readYieldSnapshot(f.readClient, f.config, {}, { ...f.proof } as VerifiedStrategySnapshot),
    ).rejects.toBeInstanceOf(YieldSnapshotUnavailable)
    expect(f.client.call).not.toHaveBeenCalled()
  })
  it('refuses a block that is no longer finalized or has a different canonical hash', async () => {
    for (const mode of ['behind', 'reorg']) {
      const f = await pinnedFixture()
      if (mode === 'behind')
        f.client.getBlock.mockResolvedValueOnce({
          number: BLOCK - 1n,
          hash: HASH,
          timestamp: TIME - 1n,
        })
      else
        f.client.getBlock
          .mockResolvedValueOnce({ number: BLOCK, hash: HASH, timestamp: TIME })
          .mockResolvedValueOnce({ number: BLOCK, hash: keccak256('0x02'), timestamp: TIME })
      await expect(readYieldSnapshot(f.readClient, f.config, {}, f.proof)).rejects.toBeInstanceOf(
        YieldSnapshotUnavailable,
      )
      expect(f.client.call).not.toHaveBeenCalled()
    }
  })
  it('accrues Venus before every accounting read in ONE pinned eth_call and preserves live ABI padding', async () => {
    const f = fixture()
    const s = await readYieldSnapshot(f.readClient, f.config)
    expect(f.client.call).toHaveBeenCalledTimes(1)
    expect(f.order[0]).toBe('accrue')
    expect(f.order.indexOf('vDebt')).toBeGreaterThan(f.order.indexOf('accrue'))
    expect(s.venues.venus.totalSupplied).toBe(200_000n * U)
    expect(s.venues.venus.actualReceiptBalance).toBe(2_500_000_000n)
    expect(s.venues.aave.supplyCap).toBe(1_000_000n * U)
    expect(s.venues.aave.accruedTreasuryAssets).toBe(2n)
    expect(s.venues.aave.reserveFactorWad).toBe(U / 10n)
    expect(s.venues.venus.model).toBeNull()
    expect(s.venues.aave.model).toBeNull()
    expect(s.nativePrice).toBeNull()
    expect(s.executionQuotes).toEqual([])
    expect(f.client.getBlock.mock.calls).toEqual([
      [{ blockTag: 'finalized' }],
      [{ blockNumber: BLOCK }],
    ])
    for (const [input] of f.client.getBytecode.mock.calls as unknown as [{ blockNumber: bigint }][])
      expect(input.blockNumber).toBe(BLOCK)
    for (const [input] of f.client.getStorageAt.mock.calls)
      expect(input).toHaveProperty('blockNumber', BLOCK)
  })

  it('treats only explicit Aave zero-cap as unlimited, preserving Venus zero-cap', async () => {
    const f = fixture()
    f.values.aCaps = [0n, 0n]
    f.values.vCap = 0n
    const s = await readYieldSnapshot(f.readClient, f.config)
    expect(s.venues.aave.supplyCap).toBeNull()
    expect(s.venues.venus.supplyCap).toBe(0n)
  })

  it('pins custom resolver reads/code and checks returned model identity against its onchain address', async () => {
    const f = fixture()
    const s = await readYieldSnapshot(f.readClient, f.config, {
      model: async (_id, address, ctx) => {
        expect(ctx.block.hash).toBe(HASH)
        expect(await ctx.read(address, 'function testRate() view returns(uint256)')).toBe(1n)
        return {
          kind: 'reviewed-two-slope',
          address,
          runtimeHash: await ctx.codeHash(address),
          verified: true,
          clock: { kind: 'annual', scale: R },
          baseBorrowRate: 0n,
          slopeBelowKink: R / 10n,
          slopeAboveKink: R,
          kinkWad: (U * 8n) / 10n,
        }
      },
    })
    expect(s.venues.venus.model?.address.toLowerCase()).toBe(addr('7'))
    expect(f.client.call).toHaveBeenCalledTimes(3)
    await expect(
      readYieldSnapshot(f.readClient, f.config, {
        model: async () =>
          ({ ...s.venues.venus.model, address: addr('9') }) as NonNullable<
            typeof s.venues.venus.model
          >,
      }),
    ).rejects.toBeInstanceOf(YieldSnapshotUnavailable)
  })

  it.each([
    'registered',
    'accrue',
    'vImplementation',
    'underlying',
    'aPool',
    'aTokens',
    'underlyingDecimals',
    'vDecimals',
    'aDecimals',
    'strategyKind',
  ])('fails closed on invalid %s without returning a partial snapshot', async (key) => {
    const f = fixture()
    f.values[key] =
      key === 'registered'
        ? false
        : key === 'accrue'
          ? 1n
          : key.endsWith('Decimals')
            ? 6
            : key === 'aTokens'
              ? [addr('9'), addr('0'), addr('9')]
              : key === 'strategyKind'
                ? `0x${'b'.repeat(64)}`
                : addr('9')
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toThrow(
      'A complete verified yield snapshot is unavailable.',
    )
  })

  it('rejects wrong RPC chain before any state read', async () => {
    const f = fixture()
    f.client.getChainId.mockResolvedValue(97)
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toBeInstanceOf(
      YieldSnapshotUnavailable,
    )
    expect(f.client.call).not.toHaveBeenCalled()
  })

  it('rejects unavailable finality and a changed canonical hash', async () => {
    const f = fixture()
    f.client.getBlock.mockResolvedValueOnce({ number: BLOCK, hash: '0x', timestamp: TIME })
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toBeInstanceOf(
      YieldSnapshotUnavailable,
    )
    f.client.getBlock
      .mockResolvedValueOnce({ number: BLOCK, hash: HASH, timestamp: TIME })
      .mockResolvedValueOnce({ number: BLOCK, hash: `0x${'b'.repeat(64)}`, timestamp: TIME })
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toBeInstanceOf(
      YieldSnapshotUnavailable,
    )
  })

  it('rejects changed runtime pins or proxy implementations before protocol reads', async () => {
    const f = fixture()
    f.client.getBytecode.mockResolvedValueOnce('0x6001')
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toBeInstanceOf(
      YieldSnapshotUnavailable,
    )
    expect(f.client.call).not.toHaveBeenCalled()
    f.client.getStorageAt.mockResolvedValueOnce(pad(addr('9')))
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toBeInstanceOf(
      YieldSnapshotUnavailable,
    )
    expect(f.client.call).not.toHaveBeenCalled()
  })

  it('rejects failed, incomplete, or malformed aggregate data', async () => {
    const f = fixture()
    f.behavior.failedLeg = 'vCash'
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toBeInstanceOf(
      YieldSnapshotUnavailable,
    )
    f.behavior.failedLeg = ''
    f.behavior.truncate = true
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toBeInstanceOf(
      YieldSnapshotUnavailable,
    )
    f.client.call.mockResolvedValueOnce({ data: '0x01' })
    await expect(readYieldSnapshot(f.readClient, f.config)).rejects.toBeInstanceOf(
      YieldSnapshotUnavailable,
    )
  })

  it('bounds unresponsive RPCs and sanitizes upstream error content', async () => {
    const f = fixture()
    f.client.getChainId.mockRejectedValueOnce(
      new Error('https://private-provider.invalid/secret-credential'),
    )
    const error = await readYieldSnapshot(f.readClient, f.config).catch((error: unknown) => error)
    expect(error).toMatchObject({ message: 'A complete verified yield snapshot is unavailable.' })
    expect(error).not.toHaveProperty('cause')
    f.client.getChainId.mockImplementationOnce(() => new Promise(() => {}))
    await expect(
      readYieldSnapshot(f.readClient, { ...f.config, timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(YieldSnapshotUnavailable)
  })
})
