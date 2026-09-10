import { readFileSync } from 'node:fs'
import type {
  PreparedStrategyDeployment,
  StrategyKind,
  StrategySetupInput,
} from '@aiki/contracts/strategies'
import {
  type Abi,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  keccak256,
} from 'viem'
import { vi } from 'vitest'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { prepareStrategyDeployment } from './deployment.js'
import { STRATEGY_DEPLOYMENT_ARTIFACTS as A } from './deployment-artifacts.js'
import {
  STRATEGY_PROTOCOL_ADDRESSES as P,
  reviewedStrategyAccountRuntimeHash,
  type StrategyDeploymentConfig,
} from './deployment-config.js'
import { DEPLOYMENT_ABIS, DEPLOYMENT_NAMES, deriveStrategyDeployment } from './deployment-policy.js'
import type { StrategyDeploymentReader } from './deployment-verification.js'
import { STRATEGY_EXPIRY_ENFORCER } from './grant.js'

export const da = (b: string) => `0x${b.repeat(20)}` as Hex
export const dh = (b: string) => `0x${b.repeat(32)}` as Hex
export function localArtifact(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../onchain/out/${name}.sol/${name}.json`, import.meta.url),
      'utf8',
    ),
  )
}
export function setupInput(kind: StrategyKind = 'yield'): StrategySetupInput {
  const base = {
    version: 1 as const,
    chainId: 56 as const,
    controller: da('22'),
    common: { expiresAt: '1900086400', minInterval: 60, maxDeadlineDelay: 300 },
  }
  if (kind === 'yield')
    return {
      ...base,
      kind,
      policy: {
        maxPrincipal: '1000',
        maxMove: '100',
        maxTurnover: '2000',
        minIdle: '10',
        maxVenusExposure: '900',
        maxAaveExposure: '900',
        maxLossPerMove: '1',
        maxCumulativeLoss: '10',
        maxLossBps: 100,
      },
    }
  if (kind === 'grid')
    return {
      ...base,
      kind,
      policy: {
        tickLower: -1000,
        tickUpper: 1000,
        maxInput0: '100',
        maxInput1: '100',
        fundingCap0: '1000',
        fundingCap1: '1000',
        turnoverCap0: '10000',
        turnoverCap1: '10000',
        twapWindow: 60,
        maxDeviationTicks: 100,
        minLiquidity: '1',
        maxSlippageBps: 50,
        minFillBps: 9000,
        minCycleGainBps: 10,
        hysteresisTicks: 10,
      },
      rungs: [{ buyTick: -200, sellTick: 200, lot0: '10', lot1: '10', initialSell: true }],
    }
  return {
    ...base,
    kind,
    policy: {
      twapWindow: 60,
      maxDeviationTicks: 100,
      minPoolLiquidity: '1',
      rangeWidth: 200,
      maxCenterOffsetTicks: 50,
      maxSwapSlippageBps: 50,
      maxLiquiditySlippageBps: 50,
      minSwapFillBps: 9000,
      minDeployedBps: 9000,
      maxLossBps: 100,
      maxSwap0: '100',
      maxSwap1: '100',
      maxPositionValueQuote: '1000',
      maxLossQuote: '1',
      maxCumulativeLossQuote: '10',
    },
  }
}
export function deploymentFixture(kind: StrategyKind = 'yield') {
  const owner = da('99'),
    input = setupInput(kind),
    block = { number: 100n, hash: dh('aa'), timestamp: 1900000000n }
  const codes = new Map<string, Hex>(),
    values = new Map<string, unknown>()
  const key = (address: Hex, name: string) => `${address.toLowerCase()}:${name}`
  const set = (address: Hex, name: string, value: unknown) => values.set(key(address, name), value)
  let accountCode: string = localArtifact('AiKiMandateAccount').deployedBytecode.object
  for (const slot of A.AiKiMandateAccount.template.immutableReferences)
    accountCode = `${accountCode.slice(0, 2 + slot.start * 2)}${mainnet.manager.slice(2).padStart(64, '0')}${accountCode.slice(2 + (slot.start + slot.length) * 2)}`
  codes.set(input.controller, accountCode as Hex)
  codes.set(mainnet.manager, '0x60006000')
  codes.set(
    STRATEGY_EXPIRY_ENFORCER.address,
    localArtifact('ExpiryEnforcer').deployedBytecode.object,
  )
  set(mainnet.manager as Hex, 'EXPIRY_ENFORCER', STRATEGY_EXPIRY_ENFORCER.address)
  const pin = (address: Hex, name?: string) => {
    const code = (name ? localArtifact(name).deployedBytecode.object : '0x6001') as Hex
    codes.set(address, code)
    return { address, runtimeCodeHash: keccak256(code) }
  }
  const config: StrategyDeploymentConfig = {
    version: 1,
    chainId: 56,
    manager: { address: mainnet.manager as Hex, runtimeCodeHash: mainnet.managerCodeHash as Hex },
    accountRuntimeHash: reviewedStrategyAccountRuntimeHash(),
    bindingEnforcer: pin(da('34'), 'StrategyBindingEnforcer'),
    factories: {
      yield: pin(da('31'), 'YieldVaultFactory'),
      grid: pin(da('32'), 'GridVaultFactory'),
      lp: pin(da('33'), 'LPVaultFactory'),
    },
    protocols: Object.fromEntries(
      Object.entries(P).map(([k, address]) => [k, pin(address).runtimeCodeHash]),
    ) as StrategyDeploymentConfig['protocols'],
    poolDeployer: pin(da('35')),
    implementations: {
      venus: pin(da('41')),
      comptroller: pin(da('42')),
      aavePool: pin(da('43')),
      aaveReceipt: pin(da('44')),
    },
    multicallRuntimeHash: pin('0xca11bde05977b3631167028862be2a173976ca11').runtimeCodeHash,
  }
  for (const f of Object.values(config.factories)) {
    set(f.address, 'manager', config.manager.address)
    set(f.address, 'accountRuntimeHash', config.accountRuntimeHash)
  }
  set(input.controller, 'owner', owner)
  set(input.controller, 'DELEGATION_MANAGER', config.manager.address)
  const specs: [Hex, string, unknown][] = [
    [P.pancakePool, 'factory', P.pancakeFactory],
    [P.pancakePool, 'token0', P.usdt],
    [P.pancakePool, 'token1', P.wbnb],
    [P.pancakePool, 'fee', 500],
    [P.pancakePool, 'tickSpacing', 10],
    [P.pancakeFactory, 'getPool', P.pancakePool],
    [P.pancakeFactory, 'poolDeployer', config.poolDeployer.address],
    [P.pancakeRouter, 'factory', P.pancakeFactory],
    [P.pancakeRouter, 'deployer', config.poolDeployer.address],
    [P.positionManager, 'factory', P.pancakeFactory],
    [P.positionManager, 'deployer', config.poolDeployer.address],
    [P.usdt, 'decimals', 18],
    [P.wbnb, 'decimals', 18],
    [P.venus, 'underlying', P.usdt],
    [P.venus, 'comptroller', P.comptroller],
    [P.venus, 'implementation', config.implementations.venus.address],
    [P.comptroller, 'comptrollerImplementation', config.implementations.comptroller.address],
    [P.aavePool, 'ADDRESSES_PROVIDER', P.aaveProvider],
    [P.aaveProvider, 'getPool', P.aavePool],
    [P.aaveReceipt, 'UNDERLYING_ASSET_ADDRESS', P.usdt],
    [P.aaveReceipt, 'POOL', P.aavePool],
  ]
  for (const [target, name, value] of specs) set(target, name, value)
  const derived = deriveStrategyDeployment(owner, config.factories[kind].address, input)
  set(config.factories[kind].address, 'predictForController', derived.predictedVault)
  set(config.factories[kind].address, 'expectedPolicyHash', derived.policyHash)
  let deployed = false,
    priorDeployed = false
  const vaultCode = localArtifact(DEPLOYMENT_NAMES[kind]).deployedBytecode.object as Hex
  set(derived.predictedVault, 'controller', input.controller)
  set(derived.predictedVault, 'policyHash', derived.policyHash)
  const transactionHash = dh('77')
  const tx: Record<string, unknown> = {
    hash: transactionHash,
    blockNumber: block.number,
    blockHash: block.hash,
    from: owner,
    to: config.factories[kind].address,
    input: derived.data,
    value: 0n,
    chainId: 56,
  }
  const event = DEPLOYMENT_ABIS[kind].find((e) => e.type === 'event')
  if (!event) throw Error('Missing creation event')
  const log: Record<string, unknown> = {
    address: config.factories[kind].address,
    blockNumber: block.number,
    blockHash: block.hash,
    transactionHash,
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: [event] as Abi,
      eventName: event.name,
      args: {
        vault: derived.predictedVault,
        controller: input.controller,
        policyHash: derived.policyHash,
      },
    }),
    data: encodeAbiParameters([{ type: 'address' }], [owner]),
  }
  const receipt: Record<string, unknown> = {
    transactionHash,
    blockNumber: block.number,
    blockHash: block.hash,
    from: owner,
    to: config.factories[kind].address,
    status: 'success',
    logs: [log],
  }
  const reader: StrategyDeploymentReader = {
    getChainId: vi.fn(async () => 56),
    getBlock: vi.fn(async (args) =>
      'blockTag' in args
        ? { ...block }
        : {
            ...block,
            number: args.blockNumber,
            hash: args.blockNumber === 100n ? block.hash : dh('bb'),
            timestamp: args.blockNumber === 100n ? block.timestamp : block.timestamp - 3n,
          },
    ),
    getBytecode: vi.fn(async ({ address, blockNumber }) =>
      address.toLowerCase() === derived.predictedVault
        ? (blockNumber < 100n ? priorDeployed : deployed)
          ? vaultCode
          : undefined
        : codes.get(address.toLowerCase()),
    ),
    readContract: vi.fn(async ({ address, functionName, blockNumber }) => {
      if (address === config.factories[kind].address && functionName === 'isVault')
        return blockNumber < 100n ? priorDeployed : deployed
      if (address === config.factories[kind].address && functionName === 'registeredRuntimeHash')
        return keccak256(vaultCode)
      if (!values.has(key(address, functionName))) throw Error(`Missing fixture ${functionName}`)
      return values.get(key(address, functionName))
    }),
    getStorageAt: vi.fn(
      async ({ address }) =>
        `0x${config.implementations[address === P.aavePool ? 'aavePool' : 'aaveReceipt'].address.slice(2).padStart(64, '0')}` as Hex,
    ),
    call: vi.fn(async () => ({
      data: encodeFunctionResult({
        abi: DEPLOYMENT_ABIS[kind] as Abi,
        functionName: 'createForController',
        result: derived.predictedVault,
      }),
    })),
    getTransaction: vi.fn(async () => tx),
    getTransactionReceipt: vi.fn(async () => receipt),
  }
  const prepare = () =>
    prepareStrategyDeployment({ config, owner, input, reader, nowSeconds: block.timestamp })
  const prepared = async (): Promise<PreparedStrategyDeployment> => {
    const result = await prepare()
    if (result.status !== 'prepared') throw Error(`Fixture blocked: ${JSON.stringify(result)}`)
    return result.prepared
  }
  return {
    config,
    owner,
    input,
    block,
    codes,
    values,
    set,
    reader,
    derived,
    prepare,
    prepared,
    tx,
    receipt,
    log,
    transactionHash,
    deploy: (prior = false) => {
      deployed = true
      priorDeployed = prior
    },
  }
}
