import type { StrategyBinding, StrategyKind } from '@aiki/contracts/strategies'
import { type Hex, keccak256, stringToHex } from 'viem'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { STRATEGY_ACCOUNT_RUNTIME_TEMPLATE } from './deployment-account-artifact.js'
import { STRATEGY_DEPLOYMENT_ARTIFACTS } from './deployment-artifacts.js'
import { nonzeroAddress, nonzeroHash, validateStrategyBinding } from './operation.js'
import type { StrategySnapshotTarget } from './snapshot.js'
import type { YieldSnapshotConfig } from './yield/snapshot.js'

/** Account owner is storage; every runtime immutable is the one reviewed manager. */
export function reviewedStrategyAccountRuntimeHash(): Hex {
  let code: string = STRATEGY_ACCOUNT_RUNTIME_TEMPLATE
  const manager = mainnet.manager.slice(2).padStart(64, '0')
  for (const slot of STRATEGY_DEPLOYMENT_ARTIFACTS.AiKiMandateAccount.template
    .immutableReferences) {
    if (slot.length !== 32) throw new Error('Unsupported account artifact.')
    code = `${code.slice(0, 2 + slot.start * 2)}${manager}${code.slice(2 + (slot.start + slot.length) * 2)}`
  }
  return keccak256(code as Hex)
}

export interface StrategyCodePin {
  address: Hex
  runtimeCodeHash: Hex
}
export const STRATEGY_PROTOCOL_ADDRESSES = {
  usdt: '0x55d398326f99059ff775485246999027b3197955',
  wbnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  pancakeFactory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  pancakeRouter: '0x1b81d678ffb9c0263b24a97847620c99d213eb14',
  pancakePool: '0x36696169c63e42cd08ce11f5deebbcebae652050',
  positionManager: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
  venus: '0xfd5840cd36d94d7229439859c0112a4185bc0255',
  comptroller: '0xfd36e2c2a6789db23113685031d7f16329158384',
  aavePool: '0x6807dc923806fe8fd134338eabca509979a7e0cb',
  aaveProvider: '0xff75b6da14ffbbfd355daf7a2731456b3562ba6d',
  aaveDataProvider: '0xc90df74a7c16245c5f5c5870327ceb38fe5d5328',
  aaveReceipt: '0xa9251ca9de909cb71783723713b21e4233fbf1b1',
} as const
export interface StrategyDeploymentConfig {
  version: 1
  chainId: 56
  manager: StrategyCodePin
  accountRuntimeHash: Hex
  bindingEnforcer: StrategyCodePin
  factories: Record<StrategyKind, StrategyCodePin>
  protocols: Record<keyof typeof STRATEGY_PROTOCOL_ADDRESSES, Hex>
  poolDeployer: StrategyCodePin
  implementations: Record<'venus' | 'comptroller' | 'aavePool' | 'aaveReceipt', StrategyCodePin>
  multicallRuntimeHash: Hex
}
const invalid = (): never => {
  throw new Error('Reviewed strategy deployment configuration is unavailable.')
}
export function deploymentObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    invalid()
}
const hash = (value: unknown): Hex =>
  nonzeroHash(value) ? (value.toLowerCase() as Hex) : invalid()
const pin = (value: unknown): StrategyCodePin => {
  const p = deploymentObject(value)
  exactKeys(p, ['address', 'runtimeCodeHash'])
  if (!nonzeroAddress(p.address)) return invalid()
  return { address: p.address.toLowerCase() as Hex, runtimeCodeHash: hash(p.runtimeCodeHash) }
}

/** Server-owned JSON only. No default or inferred factory/enforcer address exists. */
export function parseStrategyDeploymentConfig(value: unknown): StrategyDeploymentConfig {
  const c = deploymentObject(value)
  exactKeys(c, [
    'version',
    'chainId',
    'manager',
    'accountRuntimeHash',
    'bindingEnforcer',
    'factories',
    'protocols',
    'poolDeployer',
    'implementations',
    'multicallRuntimeHash',
  ])
  if (c.version !== 1 || c.chainId !== 56) return invalid()
  const manager = pin(c.manager)
  if (
    manager.address !== mainnet.manager.toLowerCase() ||
    manager.runtimeCodeHash !== mainnet.managerCodeHash.toLowerCase()
  )
    return invalid()
  if (hash(c.accountRuntimeHash) !== reviewedStrategyAccountRuntimeHash()) return invalid()
  const factories = deploymentObject(c.factories),
    protocols = deploymentObject(c.protocols),
    implementations = deploymentObject(c.implementations)
  exactKeys(factories, ['yield', 'grid', 'lp'])
  exactKeys(protocols, Object.keys(STRATEGY_PROTOCOL_ADDRESSES))
  exactKeys(implementations, ['venus', 'comptroller', 'aavePool', 'aaveReceipt'])
  const result: StrategyDeploymentConfig = {
    version: 1,
    chainId: 56,
    manager,
    accountRuntimeHash: hash(c.accountRuntimeHash),
    bindingEnforcer: pin(c.bindingEnforcer),
    factories: { yield: pin(factories.yield), grid: pin(factories.grid), lp: pin(factories.lp) },
    protocols: Object.fromEntries(
      Object.keys(STRATEGY_PROTOCOL_ADDRESSES).map((key) => [key, hash(protocols[key])]),
    ) as StrategyDeploymentConfig['protocols'],
    poolDeployer: pin(c.poolDeployer),
    multicallRuntimeHash: hash(c.multicallRuntimeHash),
    implementations: {
      venus: pin(implementations.venus),
      comptroller: pin(implementations.comptroller),
      aavePool: pin(implementations.aavePool),
      aaveReceipt: pin(implementations.aaveReceipt),
    },
  }
  const unique = [
    result.bindingEnforcer.address,
    ...Object.values(result.factories).map((p) => p.address),
    manager.address,
    ...Object.values(STRATEGY_PROTOCOL_ADDRESSES),
  ]
  if (new Set(unique).size !== unique.length) return invalid()
  return result
}
/** Reading configuration never reads environment keys or instantiates a wallet. */
export function loadStrategyDeploymentConfig(
  json: string | undefined,
): StrategyDeploymentConfig | null {
  if (!json?.trim()) return null
  try {
    return parseStrategyDeploymentConfig(JSON.parse(json))
  } catch {
    return null
  }
}
export function strategyDeploymentConfigDigest(config: StrategyDeploymentConfig): Hex {
  return keccak256(stringToHex(JSON.stringify(parseStrategyDeploymentConfig(config))))
}
export function strategyDeploymentSnapshotTarget(
  config: StrategyDeploymentConfig,
  binding: StrategyBinding,
): StrategySnapshotTarget {
  const c = parseStrategyDeploymentConfig(config)
  validateStrategyBinding(binding)
  return {
    binding: structuredClone(binding),
    factory: c.factories[binding.kind],
    bindingEnforcer: c.bindingEnforcer,
  }
}
export function strategyDeploymentYieldReadConfig(
  config: StrategyDeploymentConfig,
  binding: StrategyBinding,
): YieldSnapshotConfig {
  const c = parseStrategyDeploymentConfig(config)
  validateStrategyBinding(binding)
  if (binding.kind !== 'yield') return invalid()
  const legacyPin = (p: StrategyCodePin) => ({ address: p.address, runtimeHash: p.runtimeCodeHash })
  return {
    vault: binding.vault,
    controller: binding.controller,
    policyHash: binding.policyHash,
    factory: legacyPin(c.factories.yield),
    multicallRuntimeHash: c.multicallRuntimeHash,
    venusImplementation: legacyPin(c.implementations.venus),
    aaveImplementation: legacyPin(c.implementations.aavePool),
    aaveReceiptImplementation: legacyPin(c.implementations.aaveReceipt),
  }
}
