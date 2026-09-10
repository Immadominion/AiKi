import {
  type Abi,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  type PublicClient,
  parseAbi,
  toHex,
} from 'viem'
import { isVerifiedStrategySnapshot, type VerifiedStrategySnapshot } from '../snapshot.js'
import { YIELD_CANONICAL } from '../yield-planner.js'
import { ceilDiv, YIELD_RAY, YIELD_WAD } from './rates.js'
import type {
  YieldAddress,
  YieldBlock,
  YieldHash,
  YieldRateModel,
  YieldSnapshot,
  YieldVaultLimits,
} from './types.js'

export const YIELD_READ_ADDRESSES = {
  ...YIELD_CANONICAL,
  comptroller: '0xfd36e2c2a6789db23113685031d7f16329158384',
  aaveProvider: '0xff75b6da14ffbbfd355daf7a2731456b3562ba6d',
  aaveData: '0xc90df74a7c16245c5f5c5870327ceb38fe5d5328',
  multicall: '0xca11bde05977b3631167028862be2a173976ca11',
} as const

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const aggregateAbi = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
])
const LIMIT_KEYS = [
  'maxPrincipal',
  'maxMove',
  'maxTurnover',
  'minIdle',
  'maxVenusExposure',
  'maxAaveExposure',
  'maxLossPerMove',
  'maxCumulativeLoss',
  'maxLossBps',
] as const

export class YieldSnapshotUnavailable extends Error {
  constructor() {
    super('A complete verified yield snapshot is unavailable.')
    this.name = 'YieldSnapshotUnavailable'
  }
}

export interface YieldCodePin {
  address: YieldAddress
  runtimeHash: YieldHash
}
export interface YieldSnapshotConfig {
  vault: YieldAddress
  controller: YieldAddress
  policyHash: YieldHash
  factory: YieldCodePin
  multicallRuntimeHash: YieldHash
  /** Review implementations as well as proxy addresses. A changed implementation stops reads. */
  venusImplementation: YieldCodePin
  aaveImplementation: YieldCodePin
  aaveReceiptImplementation: YieldCodePin
  timeoutMs?: number
}

export interface YieldResolverContext {
  block: YieldBlock
  /** Earlier canonical blocks for measuring the actual chain clock, never newer state. */
  blockAt(number: bigint): Promise<{ number: bigint; hash: YieldHash; timestamp: number }>
  /** A read-only, block-pinned accessor. Resolver code must never use a separate latest client. */
  read(target: YieldAddress, signature: string, args?: readonly unknown[]): Promise<unknown>
  codeHash(target: YieldAddress): Promise<YieldHash>
}
export interface YieldSnapshotResolvers {
  /** No default model inference. A reviewed resolver must understand wrappers, implementation
   * pins and the exact clock. Unknown models produce null and the planner refuses allocation. */
  model?(
    id: 'venus' | 'aave',
    address: YieldAddress,
    context: YieldResolverContext,
  ): Promise<YieldRateModel | null>
  nativePrice?(context: YieldResolverContext): Promise<YieldSnapshot['nativePrice']>
}

type Read = { key: string; target: YieldAddress; signature: string; args: readonly unknown[] }
const same = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const address = (a: unknown): a is YieldAddress =>
  typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a) && !/^0x0{40}$/i.test(a)
const hash = (a: unknown): a is YieldHash =>
  typeof a === 'string' && /^0x[0-9a-f]{64}$/i.test(a) && !/^0x0{64}$/i.test(a)
const big = (v: unknown): bigint => {
  if (typeof v !== 'bigint' || v < 0n) throw new YieldSnapshotUnavailable()
  return v
}
const num = (v: unknown): number => {
  if (typeof v !== 'bigint' && typeof v !== 'number') throw new YieldSnapshotUnavailable()
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 0) throw new YieldSnapshotUnavailable()
  return n
}
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new YieldSnapshotUnavailable()
  return v
}
const tuple = (v: unknown, length: number): readonly unknown[] => {
  if (!Array.isArray(v) || v.length !== length) throw new YieldSnapshotUnavailable()
  return v
}
const abiFor = (signature: string): { abi: Abi; functionName: string } => {
  const functionName = /^function\s+(\w+)\(/.exec(signature)?.[1]
  if (!functionName) throw new YieldSnapshotUnavailable()
  return { abi: parseAbi([signature]), functionName }
}

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new YieldSnapshotUnavailable()), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** A single eth_call aggregate accrues Venus FIRST, then reads the resulting accounting.
 * Independent exchangeRateCurrent/getCash calls would not share simulated accrued state.
 * This method has no wallet, signing, funding, RPC write or transaction-broadcast capability. */
export async function readYieldSnapshot(
  client: Pick<PublicClient, 'getChainId' | 'getBlock' | 'getBytecode' | 'getStorageAt' | 'call'>,
  config: YieldSnapshotConfig,
  resolvers: YieldSnapshotResolvers = {},
  atSnapshot?: VerifiedStrategySnapshot,
): Promise<YieldSnapshot> {
  const timeout = config?.timeoutMs ?? 12_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new YieldSnapshotUnavailable()
  try {
    return await bounded(readSnapshot(client, config, resolvers, atSnapshot), timeout)
  } catch {
    throw new YieldSnapshotUnavailable()
  }
}

async function readSnapshot(
  client: Pick<PublicClient, 'getChainId' | 'getBlock' | 'getBytecode' | 'getStorageAt' | 'call'>,
  config: YieldSnapshotConfig,
  resolvers: YieldSnapshotResolvers,
  atSnapshot?: VerifiedStrategySnapshot,
): Promise<YieldSnapshot> {
  if (
    ![
      config.vault,
      config.controller,
      config.factory.address,
      config.venusImplementation.address,
      config.aaveImplementation.address,
      config.aaveReceiptImplementation.address,
    ].every(address) ||
    ![
      config.policyHash,
      config.factory.runtimeHash,
      config.multicallRuntimeHash,
      config.venusImplementation.runtimeHash,
      config.aaveImplementation.runtimeHash,
      config.aaveReceiptImplementation.runtimeHash,
    ].every(hash)
  )
    throw new YieldSnapshotUnavailable()
  if ((await client.getChainId()) !== 56) throw new YieldSnapshotUnavailable()
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (
    atSnapshot &&
    (!isVerifiedStrategySnapshot(atSnapshot) ||
      atSnapshot.state.kind !== 'yield' ||
      !same(atSnapshot.binding.vault, config.vault) ||
      !same(atSnapshot.binding.controller, config.controller) ||
      !same(atSnapshot.binding.policyHash, config.policyHash) ||
      !same(atSnapshot.factory.address, config.factory.address) ||
      !same(atSnapshot.factory.runtimeCodeHash, config.factory.runtimeHash) ||
      typeof finalized.number !== 'bigint' ||
      atSnapshot.block.number > finalized.number)
  )
    throw new YieldSnapshotUnavailable()
  const head = atSnapshot
    ? await client.getBlock({ blockNumber: atSnapshot.block.number })
    : finalized
  if (typeof head.number !== 'bigint' || head.number < 0n || !hash(head.hash))
    throw new YieldSnapshotUnavailable()
  if (
    atSnapshot &&
    (head.number !== atSnapshot.block.number ||
      !same(head.hash, atSnapshot.block.hash) ||
      head.timestamp !== atSnapshot.block.timestamp)
  )
    throw new YieldSnapshotUnavailable()
  const block: YieldBlock = {
    chainId: 56,
    number: head.number,
    hash: head.hash,
    timestamp: num(head.timestamp),
    finalized: true,
    canonical: true,
  }
  const codeHash = async (target: YieldAddress): Promise<YieldHash> => {
    const code = await client.getBytecode({ address: target, blockNumber: block.number })
    if (!code || code === '0x') throw new YieldSnapshotUnavailable()
    return keccak256(code)
  }
  await Promise.all(
    [
      config.factory,
      config.venusImplementation,
      config.aaveImplementation,
      config.aaveReceiptImplementation,
      { address: YIELD_READ_ADDRESSES.multicall, runtimeHash: config.multicallRuntimeHash },
    ].map(async (pin) => {
      if (!same(await codeHash(pin.address), pin.runtimeHash)) throw new YieldSnapshotUnavailable()
    }),
  )
  const [poolSlot, receiptSlot] = await Promise.all(
    [YIELD_CANONICAL.aave, YIELD_CANONICAL.aaveReceipt].map((target) =>
      client.getStorageAt({
        address: target,
        slot: IMPLEMENTATION_SLOT,
        blockNumber: block.number,
      }),
    ),
  )
  if (
    !poolSlot ||
    !/^0x0{24}[0-9a-f]{40}$/i.test(poolSlot) ||
    !receiptSlot ||
    !/^0x0{24}[0-9a-f]{40}$/i.test(receiptSlot) ||
    !same(`0x${poolSlot.slice(-40)}`, config.aaveImplementation.address) ||
    !same(`0x${receiptSlot.slice(-40)}`, config.aaveReceiptImplementation.address)
  )
    throw new YieldSnapshotUnavailable()

  const reads: Read[] = []
  const add = (
    key: string,
    target: YieldAddress,
    signature: string,
    args: readonly unknown[] = [],
  ) => reads.push({ key, target, signature, args })
  const { underlying, venus, aave, aaveReceipt, comptroller, aaveData, aaveProvider } =
    YIELD_READ_ADDRESSES
  add('accrue', venus, 'function accrueInterest() returns(uint256)')
  add('registered', config.factory.address, 'function isVault(address) view returns(bool)', [
    config.vault,
  ])
  for (const [name, type] of [
    ['controller', 'address'],
    ['policyHash', 'bytes32'],
    ['strategyKind', 'bytes32'],
    ['underlying', 'address'],
    ['venus', 'address'],
    ['comptroller', 'address'],
    ['aavePool', 'address'],
    ['aaveProvider', 'address'],
    ['aaveDataProvider', 'address'],
    ['aaveReceipt', 'address'],
    ['expiresAt', 'uint64'],
    ['minInterval', 'uint32'],
    ['maxDeadlineDelay', 'uint32'],
    ['operationNonce', 'uint256'],
    ['lastExecutionAt', 'uint256'],
    ['paused', 'bool'],
    ['fundedPrincipal', 'uint256'],
    ['turnover', 'uint256'],
    ['cumulativeLoss', 'uint256'],
    ['managedIdle', 'uint256'],
    ['managedVenusShares', 'uint256'],
    ['managedAaveScaled', 'uint256'],
  ] as const) {
    add(name, config.vault, `function ${name}() view returns(${type})`)
  }
  add(
    'limits',
    config.vault,
    'function limits() view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint16)',
  )
  add('idle', underlying, 'function balanceOf(address) view returns(uint256)', [config.vault])
  add('underlyingDecimals', underlying, 'function decimals() view returns(uint8)')
  for (const [key, name, type] of [
    ['vUnderlying', 'underlying', 'address'],
    ['vComptroller', 'comptroller', 'address'],
    ['vImplementation', 'implementation', 'address'],
    ['vModel', 'interestRateModel', 'address'],
    ['vCash', 'getCash', 'uint256'],
    ['vDebt', 'totalBorrows', 'uint256'],
    ['vReserves', 'totalReserves', 'uint256'],
    ['vFactor', 'reserveFactorMantissa', 'uint256'],
    ['vRate', 'exchangeRateStored', 'uint256'],
    ['vSupply', 'totalSupply', 'uint256'],
    ['vSupplyRate', 'supplyRatePerBlock', 'uint256'],
    ['vDecimals', 'decimals', 'uint8'],
  ] as const) {
    add(key, venus, `function ${name}() view returns(${type})`)
  }
  add('vBalance', venus, 'function balanceOf(address) view returns(uint256)', [config.vault])
  add(
    'vListed',
    comptroller,
    'function markets(address) view returns(bool,uint256,bool,uint256,uint256,uint96,bool)',
    [venus],
  )
  add('vPaused', comptroller, 'function protocolPaused() view returns(bool)')
  add('vMintPaused', comptroller, 'function actionPaused(address,uint8) view returns(bool)', [
    venus,
    0,
  ])
  add('vRedeemPaused', comptroller, 'function actionPaused(address,uint8) view returns(bool)', [
    venus,
    1,
  ])
  add('vCap', comptroller, 'function supplyCaps(address) view returns(uint256)', [venus])
  add('vFee', comptroller, 'function treasuryPercent() view returns(uint256)')
  add('aUnderlying', aaveReceipt, 'function UNDERLYING_ASSET_ADDRESS() view returns(address)')
  add('aPool', aaveReceipt, 'function POOL() view returns(address)')
  add('aDecimals', aaveReceipt, 'function decimals() view returns(uint8)')
  add('aBalance', aaveReceipt, 'function scaledBalanceOf(address) view returns(uint256)', [
    config.vault,
  ])
  add('aCash', underlying, 'function balanceOf(address) view returns(uint256)', [aaveReceipt])
  add('aProvider', aave, 'function ADDRESSES_PROVIDER() view returns(address)')
  add('aProviderPool', aaveProvider, 'function getPool() view returns(address)')
  add('aDataProvider', aaveData, 'function ADDRESSES_PROVIDER() view returns(address)')
  add(
    'aTokens',
    aaveData,
    'function getReserveTokensAddresses(address) view returns(address,address,address)',
    [underlying],
  )
  add(
    'aConfig',
    aaveData,
    'function getReserveConfigurationData(address) view returns(uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)',
    [underlying],
  )
  add('aPaused', aaveData, 'function getPaused(address) view returns(bool)', [underlying])
  add('aCaps', aaveData, 'function getReserveCaps(address) view returns(uint256,uint256)', [
    underlying,
  ])
  add(
    'aData',
    aaveData,
    'function getReserveData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40)',
    [underlying],
  )
  add(
    'aModel',
    aaveData,
    'function getInterestRateStrategyAddress(address) view returns(address)',
    [underlying],
  )
  add('aIndex', aave, 'function getReserveNormalizedIncome(address) view returns(uint256)', [
    underlying,
  ])
  add('aVirtual', aave, 'function getVirtualUnderlyingBalance(address) view returns(uint128)', [
    underlying,
  ])
  const callData = encodeFunctionData({
    abi: aggregateAbi,
    functionName: 'aggregate3',
    args: [
      reads.map((r) => ({
        target: r.target,
        allowFailure: false,
        callData: encodeFunctionData({ ...abiFor(r.signature), args: r.args }),
      })),
    ],
  })
  const response = await client.call({
    to: YIELD_READ_ADDRESSES.multicall,
    data: callData,
    blockNumber: block.number,
  })
  if (!response.data) throw new YieldSnapshotUnavailable()
  const results = decodeFunctionResult({
    abi: aggregateAbi,
    functionName: 'aggregate3',
    data: response.data,
  })
  if (results.length !== reads.length) throw new YieldSnapshotUnavailable()
  const values: Record<string, unknown> = {}
  for (let i = 0; i < reads.length; i++) {
    const r = reads[i]
    const result = results[i]
    if (!r || !result?.success) throw new YieldSnapshotUnavailable()
    values[r.key] = decodeFunctionResult({ ...abiFor(r.signature), data: result.returnData })
  }
  if (
    big(values.accrue) !== 0n ||
    !bool(values.registered) ||
    !same(values.controller, config.controller) ||
    !same(values.policyHash, config.policyHash) ||
    !same(values.strategyKind, keccak256(toHex('aiki.yield-allocation.v1'))) ||
    !same(values.underlying, underlying) ||
    !same(values.venus, venus) ||
    !same(values.comptroller, comptroller) ||
    !same(values.aavePool, aave) ||
    !same(values.aaveProvider, aaveProvider) ||
    !same(values.aaveDataProvider, aaveData) ||
    !same(values.aaveReceipt, aaveReceipt) ||
    !same(values.vUnderlying, underlying) ||
    !same(values.vComptroller, comptroller) ||
    !same(values.vImplementation, config.venusImplementation.address) ||
    !same(values.aUnderlying, underlying) ||
    !same(values.aPool, aave) ||
    !same(values.aProvider, aaveProvider) ||
    !same(values.aProviderPool, aave) ||
    !same(values.aDataProvider, aaveProvider) ||
    !same(tuple(values.aTokens, 3)[0], aaveReceipt) ||
    num(values.underlyingDecimals) !== 18 ||
    num(values.vDecimals) !== 8 ||
    num(values.aDecimals) !== 18
  )
    throw new YieldSnapshotUnavailable()
  const aConfig = tuple(values.aConfig, 10)
  const aData = tuple(values.aData, 12)
  const aCap = big(tuple(values.aCaps, 2)[1])
  const venusRate = big(values.vRate)
  const aaveIndex = big(values.aIndex)
  if (
    num(aConfig[0]) !== 18 ||
    venusRate === 0n ||
    aaveIndex < YIELD_RAY ||
    !address(values.vModel) ||
    !address(values.aModel)
  )
    throw new YieldSnapshotUnavailable()
  const context: YieldResolverContext = {
    block,
    codeHash,
    blockAt: async (number) => {
      if (number < 0n || number >= block.number) throw new YieldSnapshotUnavailable()
      const previous = await client.getBlock({ blockNumber: number })
      if (
        previous.number !== number ||
        !hash(previous.hash) ||
        num(previous.timestamp) >= block.timestamp
      )
        throw new YieldSnapshotUnavailable()
      return { number, hash: previous.hash, timestamp: num(previous.timestamp) }
    },
    read: async (target, signature, args = []) => {
      const abi = abiFor(signature)
      const result = await client.call({
        to: target,
        data: encodeFunctionData({ ...abi, args }),
        blockNumber: block.number,
      })
      if (!result.data) throw new YieldSnapshotUnavailable()
      return decodeFunctionResult({ ...abi, data: result.data })
    },
  }
  const [venusModel, aaveModel, nativePrice] = await Promise.all([
    resolvers.model?.('venus', values.vModel, context) ?? null,
    resolvers.model?.('aave', values.aModel, context) ?? null,
    resolvers.nativePrice?.(context) ?? null,
  ])
  for (const [model, expected] of [
    [venusModel, values.vModel],
    [aaveModel, values.aModel],
  ] as const) {
    if (
      model &&
      (!same(model.address, expected) || !same(model.runtimeHash, await codeHash(model.address)))
    )
      throw new YieldSnapshotUnavailable()
  }
  const canonical = await client.getBlock({ blockNumber: block.number })
  if (!same(canonical.hash, block.hash) || canonical.number !== block.number)
    throw new YieldSnapshotUnavailable()
  const rawLimits = tuple(values.limits, 9)
  const limits = Object.fromEntries(
    LIMIT_KEYS.map((key, i) => [key, key === 'maxLossBps' ? num(rawLimits[i]) : big(rawLimits[i])]),
  ) as unknown as YieldVaultLimits
  const commonVenue = {
    blockNumber: block.number,
    blockHash: block.hash,
    identityVerified: true as const,
    underlying,
    decimals: 18 as const,
    legacy: false,
  }
  return {
    block,
    vault: config.vault,
    controller: config.controller,
    policyHash: config.policyHash,
    identityVerified: true,
    expiresAt: num(values.expiresAt),
    minInterval: num(values.minInterval),
    maxDeadlineDelay: num(values.maxDeadlineDelay),
    limits,
    nonce: big(values.operationNonce),
    lastExecutionAt: num(values.lastExecutionAt),
    paused: bool(values.paused),
    fundedPrincipal: big(values.fundedPrincipal),
    turnover: big(values.turnover),
    cumulativeLoss: big(values.cumulativeLoss),
    managedIdle: big(values.managedIdle),
    actualIdle: big(values.idle),
    managedVenusShares: big(values.managedVenusShares),
    managedAaveScaled: big(values.managedAaveScaled),
    nativePrice,
    executionQuotes: [],
    venues: {
      venus: {
        ...commonVenue,
        id: 'venus',
        market: venus,
        receipt: venus,
        listed: bool(tuple(values.vListed, 7)[0]),
        active: !bool(values.vPaused),
        supplyPaused: bool(values.vPaused) || bool(values.vMintPaused),
        withdrawPaused: bool(values.vPaused) || bool(values.vRedeemPaused),
        frozen: false,
        cash: big(values.vCash),
        virtualCash: big(values.vCash),
        debt: big(values.vDebt),
        reserves: big(values.vReserves),
        unbacked: 0n,
        stableDebt: 0n,
        reserveFactorWad: big(values.vFactor),
        totalSupplied: (big(values.vSupply) * venusRate) / YIELD_WAD,
        accruedTreasuryAssets: 0n,
        supplyCap: big(values.vCap),
        withdrawalFeeWad: big(values.vFee),
        receiptRate: venusRate,
        actualReceiptBalance: big(values.vBalance),
        observedSupplyRate: big(values.vSupplyRate),
        model: venusModel,
      },
      aave: {
        ...commonVenue,
        id: 'aave',
        market: aave,
        receipt: aaveReceipt,
        listed: true,
        active: bool(aConfig[8]),
        supplyPaused: bool(values.aPaused),
        withdrawPaused: bool(values.aPaused),
        frozen: bool(aConfig[9]),
        cash: big(values.aCash),
        virtualCash: big(values.aVirtual),
        debt: big(aData[4]),
        reserves: 0n,
        unbacked: big(aData[0]),
        stableDebt: big(aData[3]),
        reserveFactorWad: (big(aConfig[4]) * YIELD_WAD) / 10_000n,
        totalSupplied: big(aData[2]),
        accruedTreasuryAssets: ceilDiv(big(aData[1]) * aaveIndex, YIELD_RAY),
        supplyCap: aCap === 0n ? null : aCap * YIELD_WAD,
        withdrawalFeeWad: 0n,
        receiptRate: aaveIndex,
        actualReceiptBalance: big(values.aBalance),
        observedSupplyRate: big(aData[5]),
        model: aaveModel,
      },
    },
  }
}
