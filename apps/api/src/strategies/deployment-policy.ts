import {
  GridStrategyVaultAbi,
  GridVaultFactoryAbi,
  LPVaultFactoryAbi,
  PancakeLPVaultAbi,
  type StrategyKind,
  type StrategySetupInput,
  YieldAllocationVaultAbi,
  YieldVaultFactoryAbi,
} from '@aiki/contracts/strategies'
import {
  type Abi,
  type AbiParameter,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  type Hex,
  keccak256,
  stringToHex,
} from 'viem'
import { STRATEGY_DEPLOYMENT_ARTIFACTS } from './deployment-artifacts.js'
import {
  deploymentObject,
  exactKeys,
  STRATEGY_PROTOCOL_ADDRESSES as P,
} from './deployment-config.js'
import { mulDivRoundingUp, quoteAtTick } from './grid/math.js'
import { nonzeroAddress, STRATEGY_KIND_HASH } from './operation.js'

export const DEPLOYMENT_ABIS = {
  yield: YieldVaultFactoryAbi,
  grid: GridVaultFactoryAbi,
  lp: LPVaultFactoryAbi,
} as const
export const DEPLOYMENT_VAULT_ABIS = {
  yield: YieldAllocationVaultAbi,
  grid: GridStrategyVaultAbi,
  lp: PancakeLPVaultAbi,
} as const
export const DEPLOYMENT_NAMES = {
  yield: 'YieldAllocationVault',
  grid: 'GridStrategyVault',
  lp: 'PancakeLPVault',
} as const
export const DEPLOYMENT_FACTORY_NAMES = {
  yield: 'YieldVaultFactory',
  grid: 'GridVaultFactory',
  lp: 'LPVaultFactory',
} as const
export const canonicalDeploymentProtocol = (kind: StrategyKind) =>
  kind === 'yield'
    ? {
        underlying: P.usdt,
        venus: P.venus,
        comptroller: P.comptroller,
        aavePool: P.aavePool,
        aaveProvider: P.aaveProvider,
        aaveDataProvider: P.aaveDataProvider,
        aaveReceipt: P.aaveReceipt,
      }
    : kind === 'grid'
      ? {
          router: P.pancakeRouter,
          factory: P.pancakeFactory,
          pool: P.pancakePool,
          token0: P.usdt,
          token1: P.wbnb,
        }
      : {
          positionManager: P.positionManager,
          router: P.pancakeRouter,
          pool: P.pancakePool,
          quoteToken: P.usdt,
        }
const invalid = (): never => {
  throw new Error('Invalid canonical strategy setup policy.')
}
const parameterAt = (parameters: readonly AbiParameter[], index: number): AbiParameter =>
  parameters[index] ?? invalid()
const fieldName = (p: AbiParameter): string => p.name || invalid()
const constructorInputs = (kind: StrategyKind): readonly AbiParameter[] =>
  STRATEGY_DEPLOYMENT_ARTIFACTS[DEPLOYMENT_NAMES[kind]].constructorInputs

/** Enforce exact wire types and ABI widths before conversion; no floats, coercion or unknown fields. */
function wire(parameter: AbiParameter, value: unknown, toABI: boolean): unknown {
  if (parameter.type === 'tuple' || parameter.type === 'tuple[]') {
    if (!('components' in parameter)) return invalid()
    if (parameter.type === 'tuple[]') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 32) return invalid()
      return value.map((row) => wire({ ...parameter, type: 'tuple' }, row, toABI))
    }
    const row = deploymentObject(value)
    exactKeys(row, parameter.components.map(fieldName))
    return Object.fromEntries(
      parameter.components.map((c) => [fieldName(c), wire(c, row[fieldName(c)], toABI)]),
    )
  }
  const integer = /^(u?int)(\d+)$/.exec(parameter.type)
  if (integer) {
    const bits = Number(integer[2]),
      signed = integer[1] === 'int'
    if (
      bits <= 32
        ? typeof value !== 'number' || !Number.isSafeInteger(value)
        : typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78
    )
      return invalid()
    const n = BigInt(value as string | number),
      limit = 1n << BigInt(bits - (signed ? 1 : 0))
    if (n < (signed ? -limit : 0n) || n >= limit) return invalid()
    return bits <= 32 ? Number(n) : toABI ? n : n.toString()
  }
  if (parameter.type === 'bool') return typeof value === 'boolean' ? value : invalid()
  if (parameter.type === 'address') return nonzeroAddress(value) ? value.toLowerCase() : invalid()
  return invalid()
}

export function canonicalizeStrategySetupInput(value: unknown): StrategySetupInput {
  const v = deploymentObject(value)
  if (v.version !== 1 || v.chainId !== 56 || !['yield', 'grid', 'lp'].includes(v.kind as string))
    return invalid()
  const kind = v.kind as StrategyKind
  exactKeys(v, [
    'version',
    'chainId',
    'kind',
    'controller',
    'common',
    'policy',
    ...(kind === 'grid' ? ['rungs'] : []),
  ])
  const params = constructorInputs(kind)
  const input = {
    version: 1,
    chainId: 56,
    kind,
    controller: wire(parameterAt(params, 0), v.controller, false),
    common: wire(parameterAt(params, 1), v.common, false),
    policy: wire(parameterAt(params, 3), v.policy, false),
    ...(kind === 'grid' ? { rungs: wire(parameterAt(params, 4), v.rungs, false) } : {}),
  } as StrategySetupInput
  const c = input.common
  if (
    BigInt(c.expiresAt) === 0n ||
    c.minInterval > 30 * 86400 ||
    c.maxDeadlineDelay < 1 ||
    c.maxDeadlineDelay > 3600
  )
    return invalid()
  if (input.kind === 'yield') {
    const p = input.policy
    if (
      BigInt(p.maxPrincipal) === 0n ||
      BigInt(p.maxMove) === 0n ||
      BigInt(p.maxMove) > BigInt(p.maxPrincipal) ||
      BigInt(p.maxTurnover) < BigInt(p.maxMove) ||
      BigInt(p.minIdle) > BigInt(p.maxPrincipal) ||
      p.maxLossBps >= 10000 ||
      BigInt(p.maxLossPerMove) > BigInt(p.maxMove) ||
      BigInt(p.maxCumulativeLoss) < BigInt(p.maxLossPerMove) ||
      (BigInt(p.maxVenusExposure) === 0n && BigInt(p.maxAaveExposure) === 0n)
    )
      return invalid()
  } else if (input.kind === 'grid') {
    const p = input.policy
    if (
      c.minInterval === 0 ||
      c.maxDeadlineDelay > 300 ||
      p.tickLower <= -887272 ||
      p.tickUpper >= 887272 ||
      p.tickLower >= p.tickUpper ||
      BigInt(p.maxInput0) === 0n ||
      BigInt(p.maxInput1) === 0n ||
      (BigInt(p.fundingCap0) === 0n && BigInt(p.fundingCap1) === 0n) ||
      BigInt(p.turnoverCap0) < BigInt(p.maxInput0) ||
      BigInt(p.turnoverCap1) < BigInt(p.maxInput1) ||
      p.twapWindow < 60 ||
      p.twapWindow > 86400 ||
      BigInt(p.minLiquidity) === 0n ||
      p.maxDeviationTicks > 10000 ||
      p.maxSlippageBps > 500 ||
      p.minFillBps < 100 ||
      p.minFillBps > 10000 ||
      p.minCycleGainBps < 1 ||
      p.minCycleGainBps > 10000 ||
      p.hysteresisTicks === 0
    )
      return invalid()
    const discount = (v: bigint) =>
      (((v * 999500n) / 1000000n) * BigInt(10000 - p.maxSlippageBps)) / 10000n
    for (const [i, r] of input.rungs.entries()) {
      const prior = input.rungs[i - 1],
        width = r.sellTick - r.buyTick
      if (
        r.buyTick <= p.tickLower ||
        r.sellTick >= p.tickUpper ||
        width <= 2 * p.hysteresisTicks ||
        width > 887272 ||
        BigInt(r.lot0) === 0n ||
        BigInt(r.lot1) === 0n ||
        BigInt(r.lot0) > BigInt(p.maxInput0) ||
        BigInt(r.lot1) > BigInt(p.maxInput1) ||
        (prior && (r.buyTick <= prior.buyTick || r.sellTick <= prior.sellTick))
      )
        return invalid()
      const roundTrip = discount(discount(quoteAtTick(width, 10n ** 18n, P.usdt, P.wbnb)))
      if (roundTrip < mulDivRoundingUp(10n ** 18n, BigInt(10000 + p.minCycleGainBps), 10000n))
        return invalid()
    }
  } else {
    const p = input.policy
    if (
      p.twapWindow === 0 ||
      p.maxDeviationTicks === 0 ||
      p.maxDeviationTicks > 887272 ||
      BigInt(p.minPoolLiquidity) === 0n ||
      p.rangeWidth <= 0 ||
      p.rangeWidth % 10 !== 0 ||
      p.maxCenterOffsetTicks > p.maxDeviationTicks ||
      p.maxSwapSlippageBps >= 10000 ||
      p.maxLiquiditySlippageBps >= 10000 ||
      p.minSwapFillBps === 0 ||
      p.minSwapFillBps > 10000 ||
      p.minDeployedBps === 0 ||
      p.minDeployedBps > 10000 ||
      p.maxLossBps >= 10000 ||
      BigInt(p.maxPositionValueQuote) === 0n ||
      BigInt(p.maxLossQuote) > BigInt(p.maxCumulativeLossQuote)
    )
      return invalid()
  }
  return input
}

/** Independent CREATE2 and policy calculation, cross-checked against the reviewed live factory. */
export function deriveStrategyDeployment(owner: Hex, factory: Hex, raw: unknown) {
  if (!nonzeroAddress(owner) || !nonzeroAddress(factory)) return invalid()
  const input = canonicalizeStrategySetupInput(raw),
    params = constructorInputs(input.kind)
  const common = wire(parameterAt(params, 1), input.common, true),
    policy = wire(parameterAt(params, 3), input.policy, true)
  const protocol = canonicalDeploymentProtocol(input.kind)
  const rungs = input.kind === 'grid' ? wire(parameterAt(params, 4), input.rungs, true) : undefined
  const args = [
    input.controller,
    common,
    protocol,
    policy,
    ...(input.kind === 'grid' ? [rungs] : []),
  ]
  const creationCode = STRATEGY_DEPLOYMENT_ARTIFACTS[DEPLOYMENT_NAMES[input.kind]]
    .creationCode as Hex
  const initCode = concatHex([creationCode, encodeAbiParameters(params, args as never)])
  const domain = input.kind === 'grid' ? 'AIKI_PANCAKE_GRID_V1' : STRATEGY_KIND_HASH[input.kind]
  const policyHash = keccak256(
    encodeAbiParameters(
      [{ type: input.kind === 'grid' ? 'string' : 'bytes32' }, { type: 'uint256' }, ...params],
      [domain, 56n, ...args] as never,
    ),
  )
  const saltParams = [
    { type: 'address' },
    parameterAt(params, 0),
    parameterAt(params, 1),
    parameterAt(params, 3),
    ...(input.kind === 'grid' ? [parameterAt(params, 4)] : []),
    { type: 'bytes32' },
  ]
  const salt = keccak256(
    encodeAbiParameters(saltParams, [
      owner,
      input.controller,
      common,
      policy,
      ...(input.kind === 'grid' ? [rungs] : []),
      keccak256(creationCode),
    ] as never),
  )
  const predictedVault = getCreate2Address({
    from: factory,
    salt,
    bytecode: initCode,
  }).toLowerCase() as Hex
  const factoryArgs = [
    input.controller,
    common,
    policy,
    ...(input.kind === 'grid' ? [rungs] : []),
    ...(input.kind === 'yield' ? [] : [creationCode]),
  ]
  const data = encodeFunctionData({
    abi: DEPLOYMENT_ABIS[input.kind] as Abi,
    functionName: 'createForController',
    args: factoryArgs,
  })
  return {
    input,
    policyHash,
    salt,
    predictedVault,
    data,
    factoryArgs,
    hashArgs: factoryArgs.slice(0, input.kind === 'grid' ? 4 : 3),
    creationCodeHash: keccak256(creationCode),
  }
}
export function deploymentRequestDigest(value: object): Hex {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, canonical(v)]),
      )
    return value
  }
  return keccak256(stringToHex(JSON.stringify(canonical(value))))
}
