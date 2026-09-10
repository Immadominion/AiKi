import {
  GridStrategyVaultAbi,
  PancakeLPVaultAbi,
  type StrategyBinding,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import { encodeAbiParameters, encodeFunctionData, type Hex, keccak256, stringToHex } from 'viem'

export interface RungBefore {
  inventory0: bigint
  inventory1: bigint
  cycle: bigint
  nextSell: boolean
  armed: boolean
}

interface OperationBase {
  binding: StrategyBinding
  expectedNonce: bigint
  deadline: bigint
}

export type StrategyOperation = OperationBase &
  (
    | {
        kind: 'yield'
        source: 0 | 1 | 2
        destination: 0 | 1 | 2
        assets: bigint
        minReceived: bigint
      }
    | { kind: 'grid'; rungIndex: number; before: RungBefore; baseline: boolean }
    | {
        kind: 'lp'
        expectedTokenId: bigint
        tickLower: number
        tickUpper: number
        zeroForOne: boolean
        swapAmount: bigint
        minSwapOut: bigint
        sqrtPriceLimitX96: bigint
        minBurn0: bigint
        minBurn1: bigint
        minMint0: bigint
        minMint1: bigint
        minLiquidity: bigint
      }
  )

export const STRATEGY_KIND_HASH = {
  yield: keccak256(stringToHex('aiki.yield-allocation.v1')),
  grid: keccak256(stringToHex('AIKI_PANCAKE_GRID_V1')),
  lp: keccak256(stringToHex('AIKI_PANCAKE_LP_V1')),
} as const

const address = /^0x[0-9a-f]{40}$/i
const hash = /^0x[0-9a-f]{64}$/i
export const nonzeroHash = (value: unknown): value is Hex =>
  typeof value === 'string' && hash.test(value) && !/^0x0{64}$/i.test(value)
export const nonzeroAddress = (value: unknown): value is Hex =>
  typeof value === 'string' && address.test(value) && !/^0x0{40}$/i.test(value)

export function validateStrategyBinding(binding: StrategyBinding) {
  if (
    binding.version !== 1 ||
    binding.chainId !== 56 ||
    !['yield', 'grid', 'lp'].includes(binding.kind) ||
    !nonzeroAddress(binding.vault) ||
    !nonzeroAddress(binding.controller) ||
    binding.vault.toLowerCase() === binding.controller.toLowerCase() ||
    !nonzeroHash(binding.policyHash) ||
    !nonzeroHash(binding.runtimeCodeHash)
  )
    throw new Error('A strategy requires a verified version-one BSC mainnet vault binding.')
}

export function encodeStrategyOperation(operation: StrategyOperation): Hex {
  validateStrategyBinding(operation.binding)
  const uint = (value: unknown, bits = 256): value is bigint =>
    typeof value === 'bigint' && value >= 0n && value < 1n << BigInt(bits)
  if (
    operation.kind !== operation.binding.kind ||
    !uint(operation.expectedNonce) ||
    !uint(operation.deadline) ||
    operation.expectedNonce >= (1n << 256n) - 1n ||
    operation.deadline <= 0n
  )
    throw new Error('Invalid strategy operation identity or nonce.')
  switch (operation.kind) {
    case 'yield':
      if (
        ![0, 1, 2].includes(operation.source) ||
        ![0, 1, 2].includes(operation.destination) ||
        operation.source === operation.destination ||
        !uint(operation.assets) ||
        !uint(operation.minReceived) ||
        operation.assets <= 0n ||
        operation.minReceived <= 0n ||
        operation.minReceived > operation.assets
      )
        throw new Error('Invalid same-asset yield move.')
      return encodeFunctionData({
        abi: YieldAllocationVaultAbi,
        functionName: 'reallocate',
        args: [
          operation.source,
          operation.destination,
          operation.assets,
          operation.minReceived,
          operation.expectedNonce,
          operation.deadline,
        ],
      })
    case 'grid':
      if (
        !Number.isSafeInteger(operation.rungIndex) ||
        operation.rungIndex < 0 ||
        operation.rungIndex > 0xffff_ffff ||
        !uint(operation.before.inventory0) ||
        !uint(operation.before.inventory1) ||
        !uint(operation.before.cycle, 64) ||
        typeof operation.before.nextSell !== 'boolean' ||
        typeof operation.before.armed !== 'boolean' ||
        typeof operation.baseline !== 'boolean'
      )
        throw new Error('Invalid grid rung snapshot.')
      return encodeFunctionData({
        abi: GridStrategyVaultAbi,
        functionName: 'execute',
        args: [operation.expectedNonce, operation.deadline, operation.rungIndex],
      })
    case 'lp':
      if (
        !uint(operation.expectedTokenId) ||
        !uint(operation.swapAmount) ||
        !uint(operation.minSwapOut) ||
        !uint(operation.sqrtPriceLimitX96, 160) ||
        !uint(operation.minBurn0) ||
        !uint(operation.minBurn1) ||
        !uint(operation.minMint0) ||
        !uint(operation.minMint1) ||
        !uint(operation.minLiquidity, 128) ||
        typeof operation.zeroForOne !== 'boolean' ||
        !Number.isSafeInteger(operation.tickLower) ||
        !Number.isSafeInteger(operation.tickUpper) ||
        operation.tickLower < -887272 ||
        operation.tickUpper > 887272 ||
        operation.expectedTokenId <= 0n ||
        operation.tickLower >= operation.tickUpper ||
        operation.minLiquidity <= 0n ||
        (operation.swapAmount === 0n &&
          (operation.minSwapOut !== 0n || operation.sqrtPriceLimitX96 !== 0n))
      )
        throw new Error('Invalid LP replacement plan.')
      return encodeFunctionData({
        abi: PancakeLPVaultAbi,
        functionName: 'rebalance',
        args: [operation],
      })
  }
}

/** Strict recovery codec. Only canonical JSON produced for a reviewed operation is accepted. */
export function decodeStoredStrategyOperation(value: unknown): StrategyOperation {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid stored strategy object.')
    return value as Record<string, unknown>
  }
  const exact = (value: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
      throw new Error('Stored strategy fields differ from the supported operation.')
  }
  const integer = (value: unknown): bigint => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error('Invalid stored strategy integer.')
    const result = BigInt(value)
    if (result >= 1n << 256n) throw new Error('Stored strategy integer overflow.')
    return result
  }
  const raw = structuredClone(record(value)),
    binding = record(raw.binding)
  exact(binding, [
    'version',
    'chainId',
    'kind',
    'vault',
    'controller',
    'policyHash',
    'runtimeCodeHash',
  ])
  const fields =
    raw.kind === 'yield'
      ? ['source', 'destination', 'assets', 'minReceived']
      : raw.kind === 'grid'
        ? ['rungIndex', 'before', 'baseline']
        : raw.kind === 'lp'
          ? [
              'expectedTokenId',
              'tickLower',
              'tickUpper',
              'zeroForOne',
              'swapAmount',
              'minSwapOut',
              'sqrtPriceLimitX96',
              'minBurn0',
              'minBurn1',
              'minMint0',
              'minMint1',
              'minLiquidity',
            ]
          : []
  if (fields.length === 0) throw new Error('Unknown stored strategy kind.')
  exact(raw, ['binding', 'kind', 'expectedNonce', 'deadline', ...fields])
  for (const key of [
    'expectedNonce',
    'deadline',
    ...(raw.kind === 'yield'
      ? ['assets', 'minReceived']
      : raw.kind === 'lp'
        ? [
            'expectedTokenId',
            'swapAmount',
            'minSwapOut',
            'sqrtPriceLimitX96',
            'minBurn0',
            'minBurn1',
            'minMint0',
            'minMint1',
            'minLiquidity',
          ]
        : []),
  ])
    raw[key] = integer(raw[key])
  if (raw.kind === 'grid') {
    const before = record(raw.before)
    exact(before, ['inventory0', 'inventory1', 'cycle', 'nextSell', 'armed'])
    for (const key of ['inventory0', 'inventory1', 'cycle']) before[key] = integer(before[key])
  }
  const operation = raw as unknown as StrategyOperation
  encodeStrategyOperation(operation)
  return operation
}

/** Stable intent identity also commits the Grid pre-state, which is not a calldata argument. */
export function strategyOperationDigest(operation: StrategyOperation): Hex {
  encodeStrategyOperation(operation)
  const canonical = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString()
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      )
    return value
  }
  return keccak256(stringToHex(JSON.stringify(canonical(operation))))
}

/** Grid hashes execution-time observations in addition to the prepared call and prior inventory. */
export function strategyPlanHash(
  operation: StrategyOperation,
  observation?: { spot: number; twap: number; baseline: boolean },
): Hex {
  const callData = encodeStrategyOperation(operation)
  if (operation.kind === 'yield') return keccak256(callData)
  // RebalancePlan is a static tuple: abi.encode(plan) is calldata without its selector.
  if (operation.kind === 'lp') return keccak256(`0x${callData.slice(10)}`)
  if (!observation || observation.baseline !== operation.baseline)
    throw new Error('Grid observation must match the prepared baseline state.')
  const r = operation.before
  const prior = keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'bool' },
      ],
      [r.inventory0, r.inventory1, r.cycle, r.nextSell, r.armed],
    ),
  )
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'bool' },
        { type: 'int24' },
        { type: 'int24' },
      ],
      [
        operation.binding.policyHash,
        operation.expectedNonce,
        operation.deadline,
        operation.rungIndex,
        prior,
        observation.baseline,
        observation.spot,
        observation.twap,
      ],
    ),
  )
}
