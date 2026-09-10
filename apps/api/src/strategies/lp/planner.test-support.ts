import { ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import { type Hex, keccak256 } from 'viem'
import { vi } from 'vitest'
import { encodeStrategyBindingTerms } from '../grant.js'
import { sqrtRatioAtTick } from '../grid/math.js'
import { decideLP, type LPPlannerPolicy, type LPStrategyOperation } from '../lp-planner.js'
import { quoteStrategyOperation, type StrategySimulationReader } from '../simulation.js'
import type { StrategySnapshotReader } from '../snapshot.js'
import { snapshotFixture } from '../snapshot.test-support.js'
import { readLPPoolState } from './market.js'

export const a = (byte: string) => `0x${byte.repeat(20)}` as Hex
export const h = (byte: string) => `0x${byte.repeat(32)}` as Hex
export const NOW = 1_900_000_000n
export const L = 10n ** 18n
export const LP_TEST_POLICY: LPPlannerPolicy = {
  poolRuntimeCodeHash: keccak256('0x6004'),
  maxSnapshotAgeSeconds: 30,
  triggerEdgeTicks: 20,
  maxSwapImpactTicks: 50,
  swapSlippageBps: 100,
  liquiditySlippageBps: 100,
  deadlineSeconds: 120,
  minDeadlineSlackSeconds: 10,
  maxGasCostWei: 10n ** 16n,
  gasBufferBps: 2000,
  maxSimulations: 12,
  simulationTimeoutMs: 1000,
}

/** Fixture uses real snapshot/market/simulation proof issuers with mocked read-only transports. */
export function lpFixture(
  options: {
    lower?: number
    upper?: number
    spot?: number
    twap?: number
    blockTimestamp?: bigint
    paused?: boolean
    expiresAt?: bigint
    lastExecutionAt?: bigint
  } = {},
) {
  const blockTimestamp = options.blockTimestamp ?? NOW
  const base = snapshotFixture('lp', {
    timestamp: blockTimestamp,
    ...(options.paused === undefined ? {} : { paused: options.paused }),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    managerCode: '0x6005',
  })
  const vault = base.target.binding.vault
  base.setVault('lpPolicy', [
    300,
    100,
    10n ** 12n,
    200,
    50,
    100,
    100,
    9500,
    8000,
    100,
    100n * L,
    100n * L,
    10_000n * L,
    10n * L,
    100n * L,
  ])
  base.setVault('positionLiquidity', L)
  base.setVault('idle0', 0n)
  base.setVault('idle1', 0n)
  base.setVault('cumulativeLossQuote', 0n)
  if (options.lastExecutionAt !== undefined)
    base.setVault('lastExecutionAt', options.lastExecutionAt)
  base.set(
    a('80'),
    'positions',
    [
      0n,
      a('00'),
      a('71'),
      a('72'),
      500,
      options.lower ?? -300,
      options.upper ?? 300,
      L,
      0n,
      0n,
      0n,
      0n,
    ],
    [42n],
  )
  const spot = options.spot ?? 0,
    twap = options.twap ?? spot
  const poolValues = new Map<string, unknown>([
    ['factory', a('82')],
    ['token0', a('71')],
    ['token1', a('72')],
    ['fee', 500],
    ['tickSpacing', 10],
    ['slot0', [sqrtRatioAtTick(spot), spot, 0, 2, 2, 0, true]],
    ['liquidity', 10n ** 24n],
    [
      'observe',
      [
        [0n, BigInt(twap) * 300n],
        [0n, (300n << 128n) / 10n ** 24n],
      ],
    ],
    ['observations:1', [Number(BigInt.asUintN(32, blockTimestamp - 600n)), 0n, 0n, true]],
    ['observations:0', [Number(BigInt.asUintN(32, blockTimestamp - 600n)), 0n, 0n, true]],
  ])
  const poolReader = {
    getChainId: vi.fn(async () => 56),
    getBlock: vi.fn(
      async (_input: Parameters<StrategySnapshotReader['getBlock']>[0]) => base.canonical,
    ),
    getBytecode: vi.fn(async () => '0x6004' as Hex | undefined),
    readContract: vi.fn(
      async (input: Parameters<StrategySnapshotReader['readContract']>[0]): Promise<unknown> => {
        if (input.functionName === 'getPool') return a('83')
        const key =
          input.functionName === 'observations'
            ? `observations:${input.args?.[0]}`
            : input.functionName
        if (!poolValues.has(key)) throw new Error(`Missing pool fixture ${key}`)
        return poolValues.get(key)
      },
    ),
  } satisfies StrategySnapshotReader
  const gas = { units: 1_000_000n, price: 1_000_000_000n }
  const simulationReader = {
    getChainId: vi.fn(async () => 56),
    getGasPrice: vi.fn(async () => gas.price),
    getBlock: vi.fn(
      async (_input: Parameters<StrategySimulationReader['getBlock']>[0]) => base.canonical,
    ),
    call: vi.fn(async (_input: Parameters<StrategySimulationReader['call']>[0]) => ({
      data: '0x' as Hex,
    })),
    estimateGas: vi.fn(
      async (_input: Parameters<StrategySimulationReader['estimateGas']>[0]) => gas.units,
    ),
  } satisfies StrategySimulationReader
  const proofs = async () => {
    const checked = await base.run()
    if (checked.status !== 'verified') throw new Error('Invalid vault fixture')
    const result = await readLPPoolState(
      checked.snapshot,
      { runtimeCodeHash: LP_TEST_POLICY.poolRuntimeCodeHash },
      poolReader,
    )
    if (result.status !== 'verified') throw new Error('Invalid LP pool fixture')
    return { snapshot: checked.snapshot, pool: result.market }
  }
  const simulate = vi.fn(
    async (
      operation: LPStrategyOperation,
      snapshot: Awaited<ReturnType<typeof proofs>>['snapshot'],
    ) =>
      quoteStrategyOperation({
        operation,
        snapshot,
        executor: a('66'),
        reader: simulationReader,
        delegation: {
          delegate: a('66'),
          delegator: snapshot.binding.controller,
          authority: ROOT_AUTHORITY,
          caveats: [
            {
              enforcer: snapshot.bindingEnforcer.address,
              terms: encodeStrategyBindingTerms(snapshot.binding),
              args: '0x',
            },
          ],
          salt: 1n,
          epoch: 0n,
          signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}11b`,
        },
      }),
  )
  return {
    base,
    vault,
    poolValues,
    poolReader,
    simulationReader,
    gas,
    proofs,
    simulate,
    run: async (policy: LPPlannerPolicy = LP_TEST_POLICY, nowSeconds = NOW) =>
      decideLP({ ...(await proofs()), policy, nowSeconds }, simulate),
  }
}
