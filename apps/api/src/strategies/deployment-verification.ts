import type { StrategyKind } from '@aiki/contracts/strategies'
import { type Hex, keccak256, parseAbi } from 'viem'
import { STRATEGY_DEPLOYMENT_ARTIFACTS } from './deployment-artifacts.js'
import {
  STRATEGY_PROTOCOL_ADDRESSES as P,
  parseStrategyDeploymentConfig,
  type StrategyCodePin,
  type StrategyDeploymentConfig,
} from './deployment-config.js'
import { DEPLOYMENT_ABIS, DEPLOYMENT_FACTORY_NAMES, DEPLOYMENT_NAMES } from './deployment-policy.js'
import { STRATEGY_EXPIRY_ENFORCER } from './grant.js'
import { nonzeroAddress, nonzeroHash } from './operation.js'
import type { StrategySnapshotReader } from './snapshot.js'

export interface StrategyDeploymentReader extends StrategySnapshotReader {
  getStorageAt(input: { address: Hex; slot: Hex; blockNumber: bigint }): Promise<Hex | undefined>
  call(input: {
    account: Hex
    to: Hex
    data: Hex
    value: bigint
    blockNumber: bigint
  }): Promise<{ data?: Hex | undefined }>
  getTransaction(input: { hash: Hex }): Promise<unknown>
  getTransactionReceipt(input: { hash: Hex }): Promise<unknown>
}
export interface DeploymentBlock {
  number: bigint
  hash: Hex
  timestamp: bigint
}
export const deploymentFailure = (): never => {
  throw new Error('Strategy deployment evidence is unavailable or inconsistent.')
}
export const sameDeploymentValue = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
export function deploymentBlock(value: unknown): DeploymentBlock {
  if (!value || typeof value !== 'object') return deploymentFailure()
  const b = value as Record<string, unknown>
  if (
    typeof b.number !== 'bigint' ||
    b.number < 1n ||
    !nonzeroHash(b.hash) ||
    typeof b.timestamp !== 'bigint' ||
    b.timestamp < 1n
  )
    return deploymentFailure()
  return { number: b.number, hash: b.hash.toLowerCase() as Hex, timestamp: b.timestamp }
}
export async function assertCanonicalDeploymentBlock(
  reader: StrategySnapshotReader,
  block: DeploymentBlock,
): Promise<void> {
  const after = deploymentBlock(await reader.getBlock({ blockNumber: block.number }))
  if (
    after.hash !== block.hash ||
    after.timestamp !== block.timestamp ||
    (await reader.getChainId()) !== 56
  )
    deploymentFailure()
}
/** Compare exact compiler runtime modulo ONLY known immutable slots, not arbitrary placeholders. */
export function assertStrategyArtifactRuntime(
  name: keyof typeof STRATEGY_DEPLOYMENT_ARTIFACTS,
  code: unknown,
): asserts code is Hex {
  const t = STRATEGY_DEPLOYMENT_ARTIFACTS[name].template
  if (
    typeof code !== 'string' ||
    !/^0x(?:[0-9a-f]{2})+$/i.test(code) ||
    (code.length - 2) / 2 !== t.codeLength
  )
    return deploymentFailure()
  let masked = code
  for (const group of t.immutableGroups) {
    const values = group.map((slot) =>
      code.slice(2 + slot.start * 2, 2 + (slot.start + slot.length) * 2).toLowerCase(),
    )
    if (new Set(values).size > 1) return deploymentFailure()
  }
  for (const slot of t.immutableReferences)
    masked = `${masked.slice(0, 2 + slot.start * 2)}${'0'.repeat(slot.length * 2)}${masked.slice(2 + (slot.start + slot.length) * 2)}`
  if (keccak256(masked as Hex) !== t.maskedCodeHash) deploymentFailure()
}
export async function deploymentRead(
  reader: StrategySnapshotReader,
  blockNumber: bigint,
  address: Hex,
  signature: string,
  args?: readonly unknown[],
) {
  const name = /^function (\w+)\(/.exec(signature)?.[1]
  if (!name) return deploymentFailure()
  return reader.readContract({
    address,
    abi: parseAbi([signature]),
    functionName: name,
    ...(args ? { args } : {}),
    blockNumber,
  })
}
async function checkedCode(reader: StrategySnapshotReader, n: bigint, pin: StrategyCodePin) {
  const code = await reader.getBytecode({ address: pin.address, blockNumber: n })
  if (!code || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || keccak256(code) !== pin.runtimeCodeHash)
    return deploymentFailure()
  return code
}
const EIP1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

/** Every identity is read at ONE finalized block, then its canonical hash is rechecked. */
export async function verifyStrategyDeploymentConfiguration(
  raw: unknown,
  reader: StrategyDeploymentReader,
  options: { block?: DeploymentBlock; nowSeconds?: bigint } = {},
) {
  const config = parseStrategyDeploymentConfig(raw)
  if ((await reader.getChainId()) !== 56) return deploymentFailure()
  const block = options.block ?? deploymentBlock(await reader.getBlock({ blockTag: 'finalized' }))
  if (!options.block) {
    const now = options.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))
    if (block.timestamp > now + 5n || now - block.timestamp > 120n) return deploymentFailure()
  }
  const n = block.number,
    read = (address: Hex, signature: string, args?: readonly unknown[]) =>
      deploymentRead(reader, n, address, signature, args)
  await checkedCode(reader, n, config.manager)
  await checkedCode(reader, n, STRATEGY_EXPIRY_ENFORCER)
  if (
    !sameDeploymentValue(
      await read(config.manager.address, 'function EXPIRY_ENFORCER() view returns (address)'),
      STRATEGY_EXPIRY_ENFORCER.address,
    )
  )
    deploymentFailure()
  const enforcerCode = await checkedCode(reader, n, config.bindingEnforcer)
  assertStrategyArtifactRuntime('StrategyBindingEnforcer', enforcerCode)
  await Promise.all(
    (['yield', 'grid', 'lp'] as const).map(async (kind) => {
      const factory = config.factories[kind],
        code = await checkedCode(reader, n, factory)
      assertStrategyArtifactRuntime(DEPLOYMENT_FACTORY_NAMES[kind], code)
      if (
        !sameDeploymentValue(
          await read(factory.address, 'function manager() view returns (address)'),
          config.manager.address,
        ) ||
        !sameDeploymentValue(
          await read(factory.address, 'function accountRuntimeHash() view returns (bytes32)'),
          config.accountRuntimeHash,
        )
      )
        deploymentFailure()
    }),
  )
  await Promise.all(
    Object.entries(P).map(([key, address]) =>
      checkedCode(reader, n, { address, runtimeCodeHash: config.protocols[key as keyof typeof P] }),
    ),
  )
  await checkedCode(reader, n, config.poolDeployer)
  await checkedCode(reader, n, {
    address: '0xca11bde05977b3631167028862be2a173976ca11',
    runtimeCodeHash: config.multicallRuntimeHash,
  })
  await Promise.all(Object.values(config.implementations).map((pin) => checkedCode(reader, n, pin)))
  const identities: [Hex, string, string, (readonly unknown[])?][] = [
    [P.pancakePool, 'function factory() view returns (address)', P.pancakeFactory],
    [P.pancakePool, 'function token0() view returns (address)', P.usdt],
    [P.pancakePool, 'function token1() view returns (address)', P.wbnb],
    [
      P.pancakeFactory,
      'function getPool(address,address,uint24) view returns (address)',
      P.pancakePool,
      [P.usdt, P.wbnb, 500],
    ],
    [
      P.pancakeFactory,
      'function poolDeployer() view returns (address)',
      config.poolDeployer.address,
    ],
    [P.pancakeRouter, 'function factory() view returns (address)', P.pancakeFactory],
    [P.pancakeRouter, 'function deployer() view returns (address)', config.poolDeployer.address],
    [P.positionManager, 'function factory() view returns (address)', P.pancakeFactory],
    [P.positionManager, 'function deployer() view returns (address)', config.poolDeployer.address],
    [P.venus, 'function underlying() view returns (address)', P.usdt],
    [P.venus, 'function comptroller() view returns (address)', P.comptroller],
    [
      P.venus,
      'function implementation() view returns (address)',
      config.implementations.venus.address,
    ],
    [
      P.comptroller,
      'function comptrollerImplementation() view returns (address)',
      config.implementations.comptroller.address,
    ],
    [P.aavePool, 'function ADDRESSES_PROVIDER() view returns (address)', P.aaveProvider],
    [P.aaveProvider, 'function getPool() view returns (address)', P.aavePool],
    [P.aaveReceipt, 'function UNDERLYING_ASSET_ADDRESS() view returns (address)', P.usdt],
    [P.aaveReceipt, 'function POOL() view returns (address)', P.aavePool],
  ]
  await Promise.all(
    identities.map(async ([target, signature, expected, args]) => {
      if (!sameDeploymentValue(await read(target, signature, args), expected)) deploymentFailure()
    }),
  )
  if (
    (await read(P.pancakePool, 'function fee() view returns (uint24)')) !== 500 ||
    (await read(P.pancakePool, 'function tickSpacing() view returns (int24)')) !== 10 ||
    (await read(P.usdt, 'function decimals() view returns (uint8)')) !== 18 ||
    (await read(P.wbnb, 'function decimals() view returns (uint8)')) !== 18
  )
    deploymentFailure()
  for (const key of ['aavePool', 'aaveReceipt'] as const) {
    const slot = await reader.getStorageAt({ address: P[key], slot: EIP1967, blockNumber: n })
    if (
      !slot ||
      !/^0x0{24}[0-9a-f]{40}$/i.test(slot) ||
      !sameDeploymentValue(`0x${slot.slice(-40)}`, config.implementations[key].address)
    )
      deploymentFailure()
  }
  await assertCanonicalDeploymentBlock(reader, block)
  return { config, block }
}

export async function verifyDeploymentOwner(
  config: StrategyDeploymentConfig,
  reader: StrategySnapshotReader,
  block: DeploymentBlock,
  controller: Hex,
  owner: Hex,
) {
  if (
    !nonzeroAddress(controller) ||
    !nonzeroAddress(owner) ||
    sameDeploymentValue(controller, owner)
  )
    return deploymentFailure()
  const code = await checkedCode(reader, block.number, {
    address: controller,
    runtimeCodeHash: config.accountRuntimeHash,
  })
  assertStrategyArtifactRuntime('AiKiMandateAccount', code)
  if (
    !sameDeploymentValue(
      await deploymentRead(
        reader,
        block.number,
        controller,
        'function owner() view returns (address)',
      ),
      owner,
    ) ||
    !sameDeploymentValue(
      await deploymentRead(
        reader,
        block.number,
        controller,
        'function DELEGATION_MANAGER() view returns (address)',
      ),
      config.manager.address,
    )
  )
    deploymentFailure()
}

export async function verifyRegisteredDeployment(
  config: StrategyDeploymentConfig,
  reader: StrategySnapshotReader,
  block: DeploymentBlock,
  kind: StrategyKind,
  vault: Hex,
  controller: Hex,
  policyHash: Hex,
): Promise<Hex | null> {
  const factory = config.factories[kind],
    code = await reader.getBytecode({ address: vault, blockNumber: block.number })
  const registered = await reader.readContract({
    address: factory.address,
    abi: DEPLOYMENT_ABIS[kind],
    functionName: 'isVault',
    args: [vault],
    blockNumber: block.number,
  })
  if ((!code || code === '0x') && registered === false) return null
  assertStrategyArtifactRuntime(DEPLOYMENT_NAMES[kind], code)
  const runtimeHash = keccak256(code)
  if (
    registered !== true ||
    !sameDeploymentValue(
      await deploymentRead(
        reader,
        block.number,
        factory.address,
        'function registeredRuntimeHash(address) view returns (bytes32)',
        [vault],
      ),
      runtimeHash,
    ) ||
    !sameDeploymentValue(
      await deploymentRead(
        reader,
        block.number,
        vault,
        'function controller() view returns (address)',
      ),
      controller,
    ) ||
    !sameDeploymentValue(
      await deploymentRead(
        reader,
        block.number,
        vault,
        'function policyHash() view returns (bytes32)',
      ),
      policyHash,
    )
  )
    deploymentFailure()
  return runtimeHash
}
