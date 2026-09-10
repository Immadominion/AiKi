import {
  GridStrategyVaultAbi,
  PancakeLPVaultAbi,
  type StrategyBinding,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type ContractFunctionReturnType,
  type Hex,
  keccak256,
  parseAbi,
  toFunctionSelector,
} from 'viem'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import {
  nonzeroAddress,
  nonzeroHash,
  STRATEGY_KIND_HASH,
  validateStrategyBinding,
} from './operation.js'

/** Deployment configuration supplied by the server, never by a model or an activation request. */
export interface StrategySnapshotTarget {
  binding: StrategyBinding
  factory?: { address: Hex; runtimeCodeHash: Hex }
  bindingEnforcer?: { address: Hex; runtimeCodeHash: Hex }
}

/** Deliberately has no wallet, signing, transaction, or latest-state accessor. */
export interface StrategySnapshotReader {
  getChainId(): Promise<number>
  getBlock(input: { blockTag: 'finalized' } | { blockNumber: bigint }): Promise<unknown>
  getBytecode(input: { address: Hex; blockNumber: bigint }): Promise<Hex | undefined>
  readContract(input: {
    address: Hex
    abi: Abi
    functionName: string
    args?: readonly unknown[]
    blockNumber: bigint
  }): Promise<unknown>
}

type Amounts<K extends string> = { readonly [P in K]: bigint }
type Addresses<K extends string> = { readonly [P in K]: Hex }
export type SnapshotYieldLimits = Amounts<
  | 'maxPrincipal'
  | 'maxMove'
  | 'maxTurnover'
  | 'minIdle'
  | 'maxVenusExposure'
  | 'maxAaveExposure'
  | 'maxLossPerMove'
  | 'maxCumulativeLoss'
> & { readonly maxLossBps: number }
export type SnapshotLPLimits = Amounts<
  | 'minPoolLiquidity'
  | 'maxSwap0'
  | 'maxSwap1'
  | 'maxPositionValueQuote'
  | 'maxLossQuote'
  | 'maxCumulativeLossQuote'
> & {
  readonly twapWindow: number
  readonly maxDeviationTicks: number
  readonly rangeWidth: number
  readonly maxCenterOffsetTicks: number
  readonly maxSwapSlippageBps: number
  readonly maxLiquiditySlippageBps: number
  readonly minSwapFillBps: number
  readonly minDeployedBps: number
  readonly maxLossBps: number
}
type GridPolicy = ContractFunctionReturnType<typeof GridStrategyVaultAbi, 'view', 'gridPolicy'>
type RungPolicy = ContractFunctionReturnType<typeof GridStrategyVaultAbi, 'view', 'rungPolicy'>
type RungState = ContractFunctionReturnType<typeof GridStrategyVaultAbi, 'view', 'rungState'>

export interface SnapshotLPPosition {
  readonly owner: Hex
  readonly nonce: bigint
  readonly operator: Hex
  readonly token0: Hex
  readonly token1: Hex
  readonly fee: number
  readonly tickLower: number
  readonly tickUpper: number
  readonly liquidity: bigint
  readonly feeGrowthInside0LastX128: bigint
  readonly feeGrowthInside1LastX128: bigint
  readonly tokensOwed0: bigint
  readonly tokensOwed1: bigint
}

export type StrategySnapshotState =
  | ({
      readonly kind: 'yield'
      readonly limits: SnapshotYieldLimits
      readonly protocol: Addresses<
        | 'underlying'
        | 'venus'
        | 'comptroller'
        | 'aavePool'
        | 'aaveProvider'
        | 'aaveDataProvider'
        | 'aaveReceipt'
      >
    } & Amounts<
      | 'fundedPrincipal'
      | 'turnover'
      | 'cumulativeLoss'
      | 'managedIdle'
      | 'managedVenusShares'
      | 'managedAaveScaled'
      | 'actualIdle'
      | 'actualVenusShares'
      | 'actualAaveScaled'
    >)
  | ({
      readonly kind: 'grid'
      readonly policy: GridPolicy
      readonly protocol: Addresses<
        'router' | 'factory' | 'pool' | 'token0' | 'token1' | 'poolDeployer'
      > & {
        readonly fee: number
        readonly deploymentChainId: bigint
        readonly codeHashes: Addresses<
          'router' | 'factory' | 'pool' | 'token0' | 'token1' | 'poolDeployer'
        >
      }
      readonly initialized: boolean
      readonly lastObservedTick: number
      readonly baselineRequired: boolean
      readonly rungs: readonly {
        readonly index: number
        readonly policy: RungPolicy
        readonly state: RungState
      }[]
    } & Amounts<
      | 'allocated0'
      | 'allocated1'
      | 'funded0'
      | 'funded1'
      | 'turnover0'
      | 'turnover1'
      | 'observationNonce'
      | 'actual0'
      | 'actual1'
    >)
  | ({
      readonly kind: 'lp'
      readonly limits: SnapshotLPLimits
      readonly protocol: Addresses<
        'positionManager' | 'router' | 'pool' | 'factory' | 'token0' | 'token1' | 'quoteToken'
      > & {
        readonly fee: number
        readonly tickSpacing: number
      }
      readonly enrolled: boolean
      readonly position: SnapshotLPPosition | null
    } & Amounts<
      | 'currentTokenId'
      | 'positionLiquidity'
      | 'idle0'
      | 'idle1'
      | 'cumulativeLossQuote'
      | 'actual0'
      | 'actual1'
    >)

const verified = Symbol('verified-strategy-snapshot')
const issuedSnapshots = new WeakSet<object>()
export interface VerifiedStrategySnapshot {
  readonly [verified]: true
  readonly binding: Readonly<StrategyBinding>
  readonly owner: Hex
  readonly manager: Hex
  readonly factory: Readonly<{ address: Hex; runtimeCodeHash: Hex }>
  readonly bindingEnforcer: Readonly<{ address: Hex; runtimeCodeHash: Hex }>
  readonly block: Readonly<{ chainId: 56; number: bigint; hash: Hex; timestamp: bigint }>
  readonly nonce: bigint
  readonly paused: boolean
  readonly expiresAt: bigint
  readonly minInterval: bigint
  readonly maxDeadlineDelay: bigint
  readonly lastExecutionAt: bigint
  readonly state: StrategySnapshotState
}

export function isVerifiedStrategySnapshot(value: unknown): value is VerifiedStrategySnapshot {
  return typeof value === 'object' && value !== null && issuedSnapshots.has(value)
}

const FACTORY_ABI = parseAbi([
  'function manager() view returns (address)',
  'function accountRuntimeHash() view returns (bytes32)',
  'function isVault(address vault) view returns (bool)',
])
const ACCOUNT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function DELEGATION_MANAGER() view returns (address)',
])
const TOKEN_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function scaledBalanceOf(address account) view returns (uint256)',
])
const POSITION_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
])
const ABIS = {
  yield: YieldAllocationVaultAbi,
  grid: GridStrategyVaultAbi,
  lp: PancakeLPVaultAbi,
} as const
const OPERATIONS = { yield: 'reallocate', grid: 'execute', lp: 'rebalance' } as const
export const MAX_SNAPSHOT_GRID_RUNGS = 32
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const fail = (): never => {
  throw new Error('Unverified strategy state.')
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const uint = (value: unknown, bits = 256): bigint => {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(bits)) return fail()
  return value
}
const addr = (value: unknown): Hex =>
  nonzeroAddress(value) ? (value.toLowerCase() as Hex) : fail()
const hash = (value: unknown): Hex => (nonzeroHash(value) ? (value.toLowerCase() as Hex) : fail())

/** Validate actual ABI-decoded types, preserving bigint precision and copying all child values.
 * A cast or JSON round trip would accept lossy numbers, missing tuple fields and caller mutations. */
function checked(parameter: AbiParameter, value: unknown): unknown {
  const integer = /^(u?int)(\d+)$/.exec(parameter.type)
  if (integer) {
    const bits = Number(integer[2]),
      signed = integer[1] === 'int'
    if (
      bits <= 48
        ? typeof value !== 'number' || !Number.isSafeInteger(value)
        : typeof value !== 'bigint'
    )
      return fail()
    const n = BigInt(value as number | bigint)
    if (
      n < (signed ? -(1n << BigInt(bits - 1)) : 0n) ||
      n >= 1n << BigInt(signed ? bits - 1 : bits)
    )
      return fail()
    return value
  }
  if (parameter.type === 'bool') return typeof value === 'boolean' ? value : fail()
  if (parameter.type === 'address')
    return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)
      ? value.toLowerCase()
      : fail()
  const bytes = /^bytes(\d+)$/.exec(parameter.type)
  if (bytes)
    return typeof value === 'string' &&
      new RegExp(`^0x[0-9a-f]{${Number(bytes[1]) * 2}}$`, 'i').test(value)
      ? value.toLowerCase()
      : fail()
  if (parameter.type === 'tuple' && 'components' in parameter) {
    const tuple = object(value)
    return Object.fromEntries(
      parameter.components.map((child) => [child.name, checked(child, tuple[child.name ?? ''])]),
    )
  }
  return fail()
}

function definition(abi: Abi, name: string): AbiFunction {
  const item = abi.find((item) => item.type === 'function' && item.name === name)
  return item?.type === 'function' ? item : fail()
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** A complete current-state proof, NOT a planner quote, activation decision or receipt.
 * Expired, paused and unfunded states are faithfully returned; consumers must gate readiness.
 * Protocol solvency, oracle freshness and gas economics belong to the strategy planner. */
export async function verifyStrategySnapshot(
  input: StrategySnapshotTarget,
  reader: StrategySnapshotReader,
): Promise<
  { status: 'verified'; snapshot: VerifiedStrategySnapshot } | { status: 'blocked'; reason: string }
> {
  try {
    const target = structuredClone(input)
    validateStrategyBinding(target.binding)
    const binding = {
      ...target.binding,
      vault: addr(target.binding.vault),
      controller: addr(target.binding.controller),
      policyHash: hash(target.binding.policyHash),
      runtimeCodeHash: hash(target.binding.runtimeCodeHash),
    }
    const factory = {
      address: addr(target.factory?.address),
      runtimeCodeHash: hash(target.factory?.runtimeCodeHash),
    }
    const bindingEnforcer = {
      address: addr(target.bindingEnforcer?.address),
      runtimeCodeHash: hash(target.bindingEnforcer?.runtimeCodeHash),
    }
    if ((await reader.getChainId()) !== 56) return fail()
    const finalized = object(await reader.getBlock({ blockTag: 'finalized' }))
    const block = {
      chainId: 56 as const,
      number: uint(finalized.number),
      hash: hash(finalized.hash),
      timestamp: uint(finalized.timestamp),
    }
    const abi: Abi = ABIS[binding.kind]
    const read = async (
      address: Hex,
      abi: Abi,
      name: string,
      args?: readonly unknown[],
    ): Promise<unknown> => {
      const outputs = definition(abi, name).outputs
      const value = await reader.readContract({
        address,
        abi,
        functionName: name,
        ...(args ? { args } : {}),
        blockNumber: block.number,
      })
      const first = outputs[0]
      if (outputs.length === 1 && first) return checked(first, value)
      if (!Array.isArray(value) || value.length !== outputs.length) return fail()
      return Object.fromEntries(
        outputs.map((output, index) => [output.name, checked(output, value[index])]),
      )
    }
    const vaultRead = (name: string, args?: readonly unknown[]) =>
      read(binding.vault, abi, name, args)
    const fields = async <T>(names: readonly string[]): Promise<T> =>
      Object.fromEntries(
        await Promise.all(names.map(async (name) => [name, await vaultRead(name)])),
      ) as T
    const codeHash = async (address: Hex) => {
      const code = await reader.getBytecode({ address, blockNumber: block.number })
      if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) return fail()
      return keccak256(code)
    }
    const manager = addr(mainnet.manager)
    const [managerHash, factoryHash, vaultHash, accountHash, enforcerHash] = await Promise.all([
      codeHash(manager),
      codeHash(factory.address),
      codeHash(binding.vault),
      codeHash(binding.controller),
      codeHash(bindingEnforcer.address),
    ])
    if (
      !same(managerHash, mainnet.managerCodeHash) ||
      factoryHash !== factory.runtimeCodeHash ||
      enforcerHash !== bindingEnforcer.runtimeCodeHash ||
      vaultHash !== binding.runtimeCodeHash
    )
      return fail()
    const [
      factoryManager,
      factoryAccountHash,
      registered,
      accountManager,
      ownerValue,
      controller,
      policyHash,
      kind,
      selector,
    ] = await Promise.all([
      read(factory.address, FACTORY_ABI, 'manager'),
      read(factory.address, FACTORY_ABI, 'accountRuntimeHash'),
      read(factory.address, FACTORY_ABI, 'isVault', [binding.vault]),
      read(binding.controller, ACCOUNT_ABI, 'DELEGATION_MANAGER'),
      read(binding.controller, ACCOUNT_ABI, 'owner'),
      vaultRead('controller'),
      vaultRead('policyHash'),
      vaultRead('strategyKind'),
      vaultRead('operationSelector'),
    ])
    const owner = addr(ownerValue)
    if (
      factoryManager !== manager ||
      factoryAccountHash !== accountHash ||
      registered !== true ||
      accountManager !== manager ||
      owner === binding.controller ||
      controller !== binding.controller ||
      policyHash !== binding.policyHash ||
      kind !== STRATEGY_KIND_HASH[binding.kind] ||
      selector !== toFunctionSelector(definition(abi, OPERATIONS[binding.kind]))
    )
      return fail()
    const common = await fields<{
      operationNonce: bigint
      paused: boolean
      expiresAt: bigint
      minInterval: number
      maxDeadlineDelay: number
      lastExecutionAt: bigint
    }>([
      'operationNonce',
      'paused',
      'expiresAt',
      'minInterval',
      'maxDeadlineDelay',
      'lastExecutionAt',
    ])
    if (
      common.expiresAt === 0n ||
      common.maxDeadlineDelay === 0 ||
      common.maxDeadlineDelay > 3600 ||
      common.minInterval > 30 * 86_400 ||
      common.lastExecutionAt > block.timestamp
    )
      return fail()
    const balance = async (token: Hex, scaled = false): Promise<bigint> =>
      (await read(token, TOKEN_ABI, scaled ? 'scaledBalanceOf' : 'balanceOf', [
        binding.vault,
      ])) as bigint
    const protocolFields = async <T extends Record<string, Hex>>(
      names: readonly string[],
    ): Promise<T> => {
      const protocol = await fields<T>(names)
      for (const value of Object.values(protocol)) {
        addr(value)
        await codeHash(value)
      }
      return protocol
    }
    let state: StrategySnapshotState
    if (binding.kind === 'yield') {
      const protocol = await protocolFields<
        Extract<StrategySnapshotState, { kind: 'yield' }>['protocol']
      >([
        'underlying',
        'venus',
        'comptroller',
        'aavePool',
        'aaveProvider',
        'aaveDataProvider',
        'aaveReceipt',
      ])
      const managed = await fields<
        Amounts<
          | 'fundedPrincipal'
          | 'turnover'
          | 'cumulativeLoss'
          | 'managedIdle'
          | 'managedVenusShares'
          | 'managedAaveScaled'
        >
      >([
        'fundedPrincipal',
        'turnover',
        'cumulativeLoss',
        'managedIdle',
        'managedVenusShares',
        'managedAaveScaled',
      ])
      const limits = (await vaultRead('limits')) as SnapshotYieldLimits
      const [actualIdle, actualVenusShares, actualAaveScaled] = await Promise.all([
        balance(protocol.underlying),
        balance(protocol.venus),
        balance(protocol.aaveReceipt, true),
      ])
      if (
        actualIdle < managed.managedIdle ||
        actualVenusShares < managed.managedVenusShares ||
        actualAaveScaled < managed.managedAaveScaled ||
        managed.fundedPrincipal > limits.maxPrincipal ||
        managed.turnover > limits.maxTurnover ||
        managed.cumulativeLoss > limits.maxCumulativeLoss
      )
        return fail()
      state = {
        kind: 'yield',
        protocol,
        limits,
        ...managed,
        actualIdle,
        actualVenusShares,
        actualAaveScaled,
      }
    } else if (binding.kind === 'grid') {
      // Bound the loop BEFORE issuing any rung requests, including for hostile RPC responses.
      const count = (await vaultRead('rungCount')) as bigint
      if (count === 0n || count > BigInt(MAX_SNAPSHOT_GRID_RUNGS)) return fail()
      const addresses = await protocolFields<
        Addresses<'router' | 'factory' | 'pool' | 'token0' | 'token1' | 'poolDeployer'>
      >(['router', 'factory', 'pool', 'token0', 'token1', 'poolDeployer'])
      const protocolState = await fields<{ fee: number; deploymentChainId: bigint }>([
        'fee',
        'deploymentChainId',
      ])
      const codeHashes = Object.fromEntries(
        await Promise.all(
          Object.entries(addresses).map(async ([name, address]) => {
            const pin = hash(
              await vaultRead(name === 'poolDeployer' ? 'deployerCodeHash' : `${name}CodeHash`),
            )
            if ((await codeHash(address)) !== pin) return fail()
            return [name, pin]
          }),
        ),
      ) as Extract<StrategySnapshotState, { kind: 'grid' }>['protocol']['codeHashes']
      if (
        protocolState.deploymentChainId !== 56n ||
        addresses.token0 >= addresses.token1 ||
        protocolState.fee <= 0 ||
        protocolState.fee >= 1_000_000
      )
        return fail()
      const policy = (await vaultRead('gridPolicy')) as GridPolicy
      const totals = await fields<
        Amounts<
          | 'allocated0'
          | 'allocated1'
          | 'funded0'
          | 'funded1'
          | 'turnover0'
          | 'turnover1'
          | 'observationNonce'
        > & { initialized: boolean; lastObservedTick: number }
      >([
        'allocated0',
        'allocated1',
        'funded0',
        'funded1',
        'turnover0',
        'turnover1',
        'observationNonce',
        'initialized',
        'lastObservedTick',
      ])
      const rungs = await Promise.all(
        Array.from({ length: Number(count) }, async (_, index) => ({
          index,
          policy: (await vaultRead('rungPolicy', [index])) as RungPolicy,
          state: (await vaultRead('rungState', [index])) as RungState,
        })),
      )
      const [actual0, actual1] = await Promise.all([
        balance(addresses.token0),
        balance(addresses.token1),
      ])
      if (
        rungs.reduce((sum, rung) => sum + rung.state.inventory0, 0n) !== totals.allocated0 ||
        rungs.reduce((sum, rung) => sum + rung.state.inventory1, 0n) !== totals.allocated1 ||
        actual0 < totals.allocated0 ||
        actual1 < totals.allocated1 ||
        totals.observationNonce > common.operationNonce ||
        totals.funded0 > policy.fundingCap0 ||
        totals.funded1 > policy.fundingCap1 ||
        totals.turnover0 > policy.turnoverCap0 ||
        totals.turnover1 > policy.turnoverCap1
      )
        return fail()
      state = {
        kind: 'grid',
        protocol: { ...addresses, ...protocolState, codeHashes },
        policy,
        ...totals,
        rungs,
        actual0,
        actual1,
        baselineRequired: !totals.initialized || totals.observationNonce !== common.operationNonce,
      }
    } else {
      const addresses = await protocolFields<
        Addresses<
          'positionManager' | 'router' | 'pool' | 'factory' | 'token0' | 'token1' | 'quoteToken'
        >
      >(['positionManager', 'router', 'pool', 'factory', 'token0', 'token1', 'quoteToken'])
      const protocolState = await fields<{ fee: number; tickSpacing: number }>([
        'fee',
        'tickSpacing',
      ])
      if (
        addresses.token0 >= addresses.token1 ||
        ![addresses.token0, addresses.token1].includes(addresses.quoteToken) ||
        protocolState.fee >= 1_000_000 ||
        protocolState.tickSpacing <= 0
      )
        return fail()
      const limits = (await vaultRead('lpPolicy')) as SnapshotLPLimits
      const managed = await fields<
        Amounts<
          'currentTokenId' | 'positionLiquidity' | 'idle0' | 'idle1' | 'cumulativeLossQuote'
        > & { enrolled: boolean }
      >([
        'currentTokenId',
        'positionLiquidity',
        'idle0',
        'idle1',
        'cumulativeLossQuote',
        'enrolled',
      ])
      const [actual0, actual1] = await Promise.all([
        balance(addresses.token0),
        balance(addresses.token1),
      ])
      if (
        actual0 < managed.idle0 ||
        actual1 < managed.idle1 ||
        managed.cumulativeLossQuote > limits.maxCumulativeLossQuote
      )
        return fail()
      let position: SnapshotLPPosition | null = null
      if (managed.currentTokenId !== 0n) {
        const args = [managed.currentTokenId]
        const [positionValue, positionOwner, approved] = await Promise.all([
          read(addresses.positionManager, POSITION_ABI, 'positions', args),
          read(addresses.positionManager, POSITION_ABI, 'ownerOf', args),
          read(addresses.positionManager, POSITION_ABI, 'getApproved', args),
        ])
        position = {
          ...(positionValue as Omit<SnapshotLPPosition, 'owner'>),
          owner: addr(positionOwner),
        }
        if (
          !managed.enrolled ||
          position.owner !== binding.vault ||
          approved !== ZERO_ADDRESS ||
          position.operator !== ZERO_ADDRESS ||
          position.token0 !== addresses.token0 ||
          position.token1 !== addresses.token1 ||
          position.fee !== protocolState.fee ||
          position.liquidity === 0n ||
          position.liquidity !== managed.positionLiquidity ||
          position.tickLower < -887272 ||
          position.tickUpper > 887272 ||
          position.tickLower >= position.tickUpper ||
          position.tickLower % protocolState.tickSpacing !== 0 ||
          position.tickUpper % protocolState.tickSpacing !== 0
        )
          return fail()
      } else if (managed.positionLiquidity !== 0n || managed.idle0 !== 0n || managed.idle1 !== 0n)
        return fail()
      state = {
        kind: 'lp',
        protocol: { ...addresses, ...protocolState },
        limits,
        ...managed,
        actual0,
        actual1,
        position,
      }
    }
    const canonical = object(await reader.getBlock({ blockNumber: block.number }))
    if (
      canonical.number !== block.number ||
      !same(canonical.hash, block.hash) ||
      canonical.timestamp !== block.timestamp ||
      (await reader.getChainId()) !== 56
    )
      return fail()
    const snapshot: VerifiedStrategySnapshot = deepFreeze({
      [verified]: true as const,
      binding,
      owner,
      manager,
      factory,
      bindingEnforcer,
      block,
      nonce: common.operationNonce,
      paused: common.paused,
      expiresAt: common.expiresAt,
      minInterval: BigInt(common.minInterval),
      maxDeadlineDelay: BigInt(common.maxDeadlineDelay),
      lastExecutionAt: common.lastExecutionAt,
      state,
    })
    issuedSnapshots.add(snapshot)
    return { status: 'verified', snapshot }
  } catch {
    return {
      status: 'blocked',
      reason:
        'The configured strategy, custody or complete finalized chain state could not be verified. Activation and new operations remain unavailable.',
    }
  }
}
