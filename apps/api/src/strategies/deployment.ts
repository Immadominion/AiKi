import type {
  PreparedStrategyDeployment,
  StrategyBinding,
  StrategyDeploymentFinalization,
  StrategyDeploymentPreparation,
  StrategyFinalizedBlock,
} from '@aiki/contracts/strategies'
import { type Abi, decodeEventLog, decodeFunctionResult, type Hex, toEventSelector } from 'viem'
import {
  parseStrategyDeploymentConfig,
  type StrategyDeploymentConfig,
  strategyDeploymentConfigDigest,
} from './deployment-config.js'
import {
  DEPLOYMENT_ABIS,
  deploymentRequestDigest,
  deriveStrategyDeployment,
} from './deployment-policy.js'
import {
  assertCanonicalDeploymentBlock,
  type DeploymentBlock,
  deploymentBlock,
  deploymentFailure,
  type StrategyDeploymentReader,
  sameDeploymentValue as same,
  verifyDeploymentOwner,
  verifyRegisteredDeployment,
  verifyStrategyDeploymentConfiguration,
} from './deployment-verification.js'
import { nonzeroAddress, nonzeroHash } from './operation.js'
import { verifyStrategySnapshot } from './snapshot.js'

export type { StrategyDeploymentConfig } from './deployment-config.js'
export type { StrategyDeploymentReader } from './deployment-verification.js'

const blocked = () => ({
  status: 'blocked' as const,
  reason: 'A complete reviewed and finalized strategy deployment could not be verified.',
})
const wireBlock = (b: DeploymentBlock): StrategyFinalizedBlock => ({
  number: b.number.toString(),
  hash: b.hash,
  timestamp: b.timestamp.toString(),
})

function identity(config: StrategyDeploymentConfig, owner: Hex, input: unknown) {
  const kind = (input as { kind?: string } | null)?.kind
  if (kind !== 'yield' && kind !== 'grid' && kind !== 'lp') return deploymentFailure()
  const derived = deriveStrategyDeployment(owner, config.factories[kind].address, input)
  const unsignedTransaction = {
    chainId: 56 as const,
    from: owner.toLowerCase() as Hex,
    to: config.factories[kind].address,
    data: derived.data,
    value: '0' as const,
  }
  const fixed = {
    version: 1 as const,
    chainId: 56 as const,
    kind: derived.input.kind,
    owner: unsignedTransaction.from,
    controller: derived.input.controller,
    input: derived.input,
    configurationDigest: strategyDeploymentConfigDigest(config),
    policyHash: derived.policyHash,
    predictedVault: derived.predictedVault,
    unsignedTransaction,
  }
  return { ...derived, fixed, requestDigest: deploymentRequestDigest(fixed) }
}

/** Durably stored preparations are data, not capabilities: recompute every identity field. */
export function validatePreparedStrategyDeployment(
  config: StrategyDeploymentConfig,
  prepared: PreparedStrategyDeployment,
) {
  if (!prepared || !nonzeroAddress(prepared.owner) || typeof prepared.alreadyDeployed !== 'boolean')
    return deploymentFailure()
  const derived = identity(parseStrategyDeploymentConfig(config), prepared.owner, prepared.input)
  const { block, alreadyDeployed, requestDigest, ...fixed } = prepared
  if (
    deploymentRequestDigest(fixed) !== deploymentRequestDigest(derived.fixed) ||
    requestDigest !== derived.requestDigest ||
    !block ||
    !/^[1-9][0-9]*$/.test(block.number) ||
    !/^[1-9][0-9]*$/.test(block.timestamp) ||
    !nonzeroHash(block.hash)
  )
    return deploymentFailure()
  return derived
}

/** Read-only owner factory simulation, NEVER a send, signature, funding or account creation. */
export async function prepareStrategyDeployment(input: {
  config: StrategyDeploymentConfig | null
  owner: Hex
  input: unknown
  reader: StrategyDeploymentReader
  nowSeconds?: bigint
}): Promise<StrategyDeploymentPreparation> {
  try {
    // Validate all untrusted JSON before making any RPC call.
    const config = parseStrategyDeploymentConfig(input.config),
      derived = identity(config, input.owner, input.input)
    const { block } = await verifyStrategyDeploymentConfiguration(
      config,
      input.reader,
      input.nowSeconds === undefined ? {} : { nowSeconds: input.nowSeconds },
    )
    await verifyDeploymentOwner(config, input.reader, block, derived.input.controller, input.owner)
    const factory = config.factories[derived.input.kind].address,
      abi = DEPLOYMENT_ABIS[derived.input.kind]
    const [prediction, policy] = await Promise.all([
      input.reader.readContract({
        address: factory,
        abi,
        functionName: 'predictForController',
        args: derived.factoryArgs,
        blockNumber: block.number,
      }),
      input.reader.readContract({
        address: factory,
        abi,
        functionName: 'expectedPolicyHash',
        args: derived.hashArgs,
        blockNumber: block.number,
      }),
    ])
    if (!same(prediction, derived.predictedVault) || !same(policy, derived.policyHash))
      return deploymentFailure()
    const existing = await verifyRegisteredDeployment(
      config,
      input.reader,
      block,
      derived.input.kind,
      derived.predictedVault,
      derived.input.controller,
      derived.policyHash,
    )
    if (!existing && BigInt(derived.input.common.expiresAt) <= block.timestamp)
      return deploymentFailure()
    const simulated = await input.reader.call({
      account: input.owner,
      to: factory,
      data: derived.data,
      value: 0n,
      blockNumber: block.number,
    })
    if (
      !simulated.data ||
      !same(
        decodeFunctionResult({
          abi: abi as Abi,
          functionName: 'createForController',
          data: simulated.data,
        }),
        derived.predictedVault,
      )
    )
      return deploymentFailure()
    await assertCanonicalDeploymentBlock(input.reader, block)
    return {
      status: 'prepared',
      prepared: {
        ...derived.fixed,
        requestDigest: derived.requestDigest,
        block: wireBlock(block),
        alreadyDeployed: existing !== null,
      },
    }
  } catch {
    return blocked()
  }
}

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return deploymentFailure()
  return v as Record<string, unknown>
}

/** Only exact successful canonical finalized owner transactions may establish the binding. */
export async function finalizeStrategyDeployment(input: {
  config: StrategyDeploymentConfig | null
  prepared: PreparedStrategyDeployment
  transactionHash: Hex
  reader: StrategyDeploymentReader
  nowSeconds?: bigint
}): Promise<StrategyDeploymentFinalization> {
  try {
    const config = parseStrategyDeploymentConfig(input.config),
      prepared = structuredClone(input.prepared)
    const derived = validatePreparedStrategyDeployment(config, prepared)
    if (!nonzeroHash(input.transactionHash)) return deploymentFailure()
    const transactionHash = input.transactionHash.toLowerCase() as Hex
    const { block: head } = await verifyStrategyDeploymentConfiguration(
      config,
      input.reader,
      input.nowSeconds === undefined ? {} : { nowSeconds: input.nowSeconds },
    )
    const receiptValue = await input.reader.getTransactionReceipt({ hash: transactionHash })
    if (receiptValue === null || receiptValue === undefined)
      return { status: 'pending', reason: 'The deployment transaction has not been mined.' }
    const receipt = record(receiptValue)
    if (
      !same(receipt.transactionHash, transactionHash) ||
      typeof receipt.blockNumber !== 'bigint' ||
      !nonzeroHash(receipt.blockHash)
    )
      return deploymentFailure()
    if (receipt.blockNumber > head.number)
      return { status: 'pending', reason: 'The deployment transaction is not finalized.' }
    if (receipt.status !== 'success') return deploymentFailure()
    const block = deploymentBlock(await input.reader.getBlock({ blockNumber: receipt.blockNumber }))
    if (!same(receipt.blockHash, block.hash)) return deploymentFailure()
    const tx = record(await input.reader.getTransaction({ hash: transactionHash }))
    if (
      !same(tx.hash, transactionHash) ||
      !same(tx.blockHash, block.hash) ||
      tx.blockNumber !== block.number ||
      !same(tx.from, prepared.owner) ||
      !same(tx.to, prepared.unsignedTransaction.to) ||
      !same(tx.input, prepared.unsignedTransaction.data) ||
      tx.value !== 0n ||
      tx.chainId !== 56 ||
      !same(receipt.from, prepared.owner) ||
      !same(receipt.to, prepared.unsignedTransaction.to)
    )
      return deploymentFailure()
    await verifyStrategyDeploymentConfiguration(config, input.reader, { block })
    await verifyDeploymentOwner(config, input.reader, block, prepared.controller, prepared.owner)
    // Ownership changes since the receipt must not let a prior owner activate a vault.
    await verifyDeploymentOwner(config, input.reader, head, prepared.controller, prepared.owner)
    const runtime = await verifyRegisteredDeployment(
      config,
      input.reader,
      block,
      prepared.kind,
      prepared.predictedVault,
      prepared.controller,
      prepared.policyHash,
    )
    if (!runtime) return deploymentFailure()
    const currentRuntime = await verifyRegisteredDeployment(
      config,
      input.reader,
      head,
      prepared.kind,
      prepared.predictedVault,
      prepared.controller,
      prepared.policyHash,
    )
    if (currentRuntime !== runtime) return deploymentFailure()
    const abi = DEPLOYMENT_ABIS[prepared.kind],
      event = abi.find((entry) => entry.type === 'event') ?? deploymentFailure()
    const topic = toEventSelector(event),
      logs = receipt.logs
    if (!Array.isArray(logs)) return deploymentFailure()
    const relevant = logs
      .map(record)
      .filter(
        (log) =>
          same(log.address, prepared.unsignedTransaction.to) &&
          Array.isArray(log.topics) &&
          same(log.topics[0], topic),
      )
    if (relevant.length > 1) return deploymentFailure()
    let retry = false
    if (relevant.length === 1) {
      const log = relevant[0] ?? deploymentFailure()
      if (
        log.removed !== false ||
        !same(log.transactionHash, transactionHash) ||
        !same(log.blockHash, block.hash) ||
        log.blockNumber !== block.number ||
        !Number.isSafeInteger(log.logIndex) ||
        (log.logIndex as number) < 0
      )
        return deploymentFailure()
      const decoded = decodeEventLog({
        abi: abi as Abi,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      })
      const args = record(decoded.args)
      if (
        !same(args.vault, prepared.predictedVault) ||
        !same(args.controller, prepared.controller) ||
        !same(args.policyHash, derived.policyHash) ||
        !same(args.owner, prepared.owner)
      )
        return deploymentFailure()
    } else {
      // The reviewed immutable factory has only two successful branches: create and
      // emit, or return an already registered exact runtime/controller/policy. The
      // exact successful owner call plus the verified resulting binding above proves
      // the latter, including when an earlier transaction created it in THIS block.
      // A missing event by itself is never accepted without all those checks.
      retry = true
    }
    await assertCanonicalDeploymentBlock(input.reader, block)
    await assertCanonicalDeploymentBlock(input.reader, head)
    const binding: StrategyBinding = {
      version: 1,
      chainId: 56,
      kind: prepared.kind,
      vault: prepared.predictedVault,
      controller: prepared.controller,
      policyHash: prepared.policyHash,
      runtimeCodeHash: runtime,
    }
    return {
      status: 'verified',
      binding,
      owner: prepared.owner,
      requestDigest: prepared.requestDigest,
      transactionHash,
      block: wireBlock(block),
      retry,
    }
  } catch {
    return blocked()
  }
}

/** Re-check server pins, current ownership and exact stored request before ANY next wallet step. */
export async function readStrategySetupSnapshot(input: {
  config: StrategyDeploymentConfig | null
  prepared: PreparedStrategyDeployment
  owner?: Hex
  reader: StrategyDeploymentReader
  nowSeconds?: bigint
}) {
  try {
    const config = parseStrategyDeploymentConfig(input.config),
      prepared = structuredClone(input.prepared)
    if (input.owner !== undefined && !same(input.owner, prepared.owner)) return blocked()
    validatePreparedStrategyDeployment(config, prepared)
    const { block } = await verifyStrategyDeploymentConfiguration(
      config,
      input.reader,
      input.nowSeconds === undefined ? {} : { nowSeconds: input.nowSeconds },
    )
    await verifyDeploymentOwner(config, input.reader, block, prepared.controller, prepared.owner)
    const runtimeCodeHash = await verifyRegisteredDeployment(
      config,
      input.reader,
      block,
      prepared.kind,
      prepared.predictedVault,
      prepared.controller,
      prepared.policyHash,
    )
    if (!runtimeCodeHash) return blocked()
    const binding: StrategyBinding = {
      version: 1,
      chainId: 56,
      kind: prepared.kind,
      vault: prepared.predictedVault,
      controller: prepared.controller,
      policyHash: prepared.policyHash,
      runtimeCodeHash,
    }
    // Pin even the verifier's finalized selector to this already-checked block.
    const reader = {
      ...input.reader,
      getChainId: () => input.reader.getChainId(),
      getBytecode: input.reader.getBytecode.bind(input.reader),
      readContract: input.reader.readContract.bind(input.reader),
      getBlock: (args: { blockTag: 'finalized' } | { blockNumber: bigint }) =>
        'blockTag' in args ? Promise.resolve(block) : input.reader.getBlock(args),
    }
    const result = await verifyStrategySnapshot(
      {
        binding,
        factory: config.factories[prepared.kind],
        bindingEnforcer: config.bindingEnforcer,
      },
      reader,
    )
    if (result.status !== 'verified' || !same(result.snapshot.owner, prepared.owner))
      return blocked()
    await assertCanonicalDeploymentBlock(input.reader, block)
    return result
  } catch {
    return blocked()
  }
}
