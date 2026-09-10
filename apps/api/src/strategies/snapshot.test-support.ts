import {
  GridStrategyVaultAbi,
  PancakeLPVaultAbi,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import {
  type Abi,
  decodeFunctionResult,
  encodeFunctionResult,
  type Hex,
  keccak256,
  toFunctionSelector,
} from 'viem'
import { vi } from 'vitest'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { STRATEGY_KIND_HASH } from './operation.js'
import {
  type StrategySnapshotReader,
  type StrategySnapshotTarget,
  verifyStrategySnapshot,
} from './snapshot.js'

const a = (byte: string) => `0x${byte.repeat(20)}` as Hex
const h = (byte: string) => `0x${byte.repeat(32)}` as Hex
const zero = a('00')
const factory = a('33')
const token0 = a('71'),
  token1 = a('72'),
  nfpm = a('80')
const abiFor = { yield: YieldAllocationVaultAbi, grid: GridStrategyVaultAbi, lp: PancakeLPVaultAbi }

/** Test-only RPC responses: proofs still come from the real verifier, never a forged object. */
export function snapshotFixture(
  kind: 'yield' | 'grid' | 'lp' = 'yield',
  options: {
    binding?: Partial<StrategySnapshotTarget['binding']>
    owner?: Hex
    timestamp?: bigint
    expiresAt?: bigint
    blockNumber?: bigint
    blockHash?: Hex
    managerCode?: Hex
    vaultCode?: Hex
    nonce?: bigint
    paused?: boolean
  } = {},
) {
  const vault = options.binding?.vault ?? a('11'),
    controller = options.binding?.controller ?? a('22')
  const owner = options.owner ?? a('99'),
    timestamp = options.timestamp ?? 1_900_000_000n
  const blockNumber = options.blockNumber ?? 100n
  const vaultCode = options.vaultCode ?? '0x6003'
  kind = options.binding?.kind ?? kind
  const target: StrategySnapshotTarget = {
    binding: {
      version: 1,
      chainId: 56,
      kind,
      vault,
      controller,
      policyHash: h('44'),
      runtimeCodeHash: keccak256(vaultCode),
      ...options.binding,
    },
    factory: { address: factory, runtimeCodeHash: keccak256('0x6001') },
    bindingEnforcer: { address: a('34'), runtimeCodeHash: keccak256('0x6006') },
  }
  const finalized: Record<string, unknown> = {
    number: blockNumber,
    hash: options.blockHash ?? h('aa'),
    timestamp,
  }
  const canonical = { ...finalized }
  const codes = new Map<string, Hex | undefined>([
    [mainnet.manager, options.managerCode ?? '0x6005'],
    [factory, '0x6001'],
    [a('34'), '0x6006'],
    [controller, '0x6002'],
    [vault, vaultCode],
  ])
  const values = new Map<string, unknown>(),
    malformed = new Map<string, unknown>()
  const key = (address: string, name: string, args: readonly unknown[] = []) =>
    `${address.toLowerCase()}:${name}:${args.join(',')}`
  const set = (address: string, name: string, value: unknown, args?: readonly unknown[]) =>
    values.set(key(address, name, args), value)
  const setVault = (name: string, value: unknown, args?: readonly unknown[]) =>
    set(vault, name, value, args)
  const bad = (address: string, name: string, value: unknown, args?: readonly unknown[]) =>
    malformed.set(key(address, name, args), value)
  const protocol = (fields: Record<string, Hex>) => {
    for (const [name, address] of Object.entries(fields)) {
      setVault(name, address)
      codes.set(address, '0x6004')
    }
  }
  const functionName = kind === 'yield' ? 'reallocate' : kind === 'grid' ? 'execute' : 'rebalance'
  const operation = abiFor[kind].find(
    (item) => item.type === 'function' && item.name === functionName,
  )
  if (operation?.type !== 'function') throw new Error('Missing ABI operation')
  for (const [name, value] of Object.entries({
    controller,
    policyHash: target.binding.policyHash,
    strategyKind: STRATEGY_KIND_HASH[kind],
    operationSelector: toFunctionSelector(operation),
    operationNonce: options.nonce ?? 7n,
    paused: options.paused ?? false,
    expiresAt: options.expiresAt ?? timestamp + 1_000n,
    minInterval: 60,
    maxDeadlineDelay: 120,
    lastExecutionAt: timestamp - 60n,
  }))
    setVault(name, value)
  set(factory, 'manager', mainnet.manager)
  set(factory, 'accountRuntimeHash', keccak256('0x6002'))
  set(factory, 'isVault', true, [vault])
  set(controller, 'owner', owner)
  set(controller, 'DELEGATION_MANAGER', mainnet.manager)
  if (kind === 'yield') {
    const p = {
      underlying: a('61'),
      venus: a('62'),
      comptroller: a('63'),
      aavePool: a('64'),
      aaveProvider: a('65'),
      aaveDataProvider: a('66'),
      aaveReceipt: a('67'),
    }
    protocol(p)
    setVault('limits', [1000n, 200n, 2000n, 10n, 1000n, 1000n, 2n, 20n, 100])
    for (const [name, value] of Object.entries({
      fundedPrincipal: 300n,
      turnover: 200n,
      cumulativeLoss: 1n,
      managedIdle: 100n,
      managedVenusShares: 150n,
      managedAaveScaled: 50n,
    }))
      setVault(name, value)
    set(p.underlying, 'balanceOf', 101n, [vault])
    set(p.venus, 'balanceOf', 150n, [vault])
    set(p.aaveReceipt, 'scaledBalanceOf', 50n, [vault])
  } else if (kind === 'grid') {
    const p = {
      router: a('81'),
      factory: a('82'),
      pool: a('83'),
      token0,
      token1,
      poolDeployer: a('84'),
    }
    protocol(p)
    for (const name of Object.keys(p))
      setVault(
        name === 'poolDeployer' ? 'deployerCodeHash' : `${name}CodeHash`,
        keccak256('0x6004'),
      )
    setVault('fee', 500)
    setVault('deploymentChainId', 56n)
    setVault('rungCount', 2n)
    setVault('gridPolicy', {
      tickLower: -1000,
      tickUpper: 1000,
      maxInput0: 100n,
      maxInput1: 100n,
      fundingCap0: 1000n,
      fundingCap1: 1000n,
      turnoverCap0: 2000n,
      turnoverCap1: 2000n,
      twapWindow: 300,
      maxDeviationTicks: 100,
      minLiquidity: 100n,
      maxSlippageBps: 100,
      minFillBps: 9500,
      minCycleGainBps: 100,
      hysteresisTicks: 10,
    })
    for (const [name, value] of Object.entries({
      allocated0: 30n,
      allocated1: 70n,
      funded0: 100n,
      funded1: 100n,
      turnover0: 200n,
      turnover1: 300n,
      observationNonce: 7n,
      initialized: true,
      lastObservedTick: -50,
    }))
      setVault(name, value)
    for (let i = 0; i < 2; i++) {
      setVault(
        'rungPolicy',
        {
          buyTick: -300 + i * 100,
          sellTick: 300 + i * 100,
          lot0: 10n,
          lot1: 10n,
          initialSell: i === 0,
        },
        [i],
      )
      setVault(
        'rungState',
        {
          inventory0: BigInt(10 + i * 10),
          inventory1: BigInt(30 + i * 10),
          cycle: BigInt(i),
          nextSell: i === 0,
          armed: i === 1,
        },
        [i],
      )
    }
    set(token0, 'balanceOf', 31n, [vault])
    set(token1, 'balanceOf', 70n, [vault])
  } else {
    protocol({
      positionManager: nfpm,
      router: a('81'),
      pool: a('83'),
      factory: a('82'),
      token0,
      token1,
      quoteToken: token0,
    })
    setVault('fee', 500)
    setVault('tickSpacing', 10)
    setVault('lpPolicy', [
      300,
      100,
      1000n,
      200,
      50,
      100,
      100,
      9500,
      8000,
      100,
      100n,
      100n,
      10000n,
      10n,
      100n,
    ])
    for (const [name, value] of Object.entries({
      currentTokenId: 42n,
      positionLiquidity: 500n,
      idle0: 10n,
      idle1: 20n,
      cumulativeLossQuote: 3n,
      enrolled: true,
    }))
      setVault(name, value)
    set(token0, 'balanceOf', 11n, [vault])
    set(token1, 'balanceOf', 20n, [vault])
    set(nfpm, 'positions', [0n, zero, token0, token1, 500, -100, 100, 500n, 1n, 2n, 3n, 4n], [42n])
    set(nfpm, 'ownerOf', vault, [42n])
    set(nfpm, 'getApproved', zero, [42n])
  }
  const reader = {
    getChainId: vi.fn(async () => 56),
    getBlock: vi.fn(async (input: { blockTag: 'finalized' } | { blockNumber: bigint }) =>
      'blockTag' in input ? finalized : canonical,
    ),
    getBytecode: vi.fn(async ({ address }: { address: Hex; blockNumber: bigint }) =>
      codes.get(address.toLowerCase()),
    ),
    readContract: vi.fn(
      async (input: Parameters<StrategySnapshotReader['readContract']>[0]): Promise<unknown> => {
        const k = key(input.address, input.functionName, input.args)
        if (malformed.has(k)) return malformed.get(k)
        if (!values.has(k)) throw new Error(`Missing fixture ${k}`)
        // Round-trip the generated ABI so tuple/array and small-int/bigint shapes match a real viem reader.
        const data = encodeFunctionResult({
          abi: input.abi as Abi,
          functionName: input.functionName,
          result: values.get(k),
        })
        return decodeFunctionResult({
          abi: input.abi as Abi,
          functionName: input.functionName,
          data,
        })
      },
    ),
  } satisfies StrategySnapshotReader
  return {
    target,
    finalized,
    canonical,
    codes,
    values,
    key,
    set,
    setVault,
    bad,
    reader,
    run: () => verifyStrategySnapshot(target, reader),
  }
}
