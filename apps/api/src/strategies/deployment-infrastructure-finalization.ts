import { getContractAddress, type Hex, keccak256 } from 'viem'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import {
  deploymentObject,
  exactKeys,
  STRATEGY_PROTOCOL_ADDRESSES as P,
  parseStrategyDeploymentConfig,
  reviewedStrategyAccountRuntimeHash,
  type StrategyCodePin,
  type StrategyDeploymentConfig,
  strategyDeploymentConfigDigest,
} from './deployment-config.js'
import { strategyInfrastructureTransactions } from './deployment-infrastructure.js'
import {
  assertStrategyArtifactRuntime,
  type DeploymentBlock,
  deploymentBlock,
  deploymentFailure,
  deploymentRead,
  type StrategyDeploymentReader,
  sameDeploymentValue as same,
  verifyStrategyDeploymentConfiguration,
} from './deployment-verification.js'
import { nonzeroAddress, nonzeroHash } from './operation.js'

export const STRATEGY_INFRASTRUCTURE_NAMES = [
  'StrategyBindingEnforcer',
  'YieldVaultFactory',
  'GridVaultFactory',
  'LPVaultFactory',
] as const
type InfrastructureName = (typeof STRATEGY_INFRASTRUCTURE_NAMES)[number]
export type StrategyInfrastructureReceipts = Record<InfrastructureName, Hex>
const EIP1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11'

export function parseStrategyInfrastructureReceipts(
  value: unknown,
): StrategyInfrastructureReceipts {
  const object = deploymentObject(value)
  exactKeys(object, STRATEGY_INFRASTRUCTURE_NAMES)
  const receipts = Object.fromEntries(
    STRATEGY_INFRASTRUCTURE_NAMES.map((name) => {
      const hash = object[name]
      if (!nonzeroHash(hash)) return deploymentFailure()
      return [name, hash.toLowerCase()]
    }),
  ) as StrategyInfrastructureReceipts
  if (new Set(Object.values(receipts)).size !== 4) return deploymentFailure()
  return receipts
}

/** A deliberately flat literal-name JSON document. Reject duplicate properties before JSON.parse
 * can erase them; no caller-provided address, bytecode, nonce or protocol pin is accepted. */
export function parseStrategyInfrastructureReceiptsJSON(
  text: string,
): StrategyInfrastructureReceipts {
  if (text.length > 4096) return deploymentFailure()
  const pair = '"[A-Za-z]+"\\s*:\\s*"0x[0-9a-fA-F]{64}"'
  if (!new RegExp(`^\\s*\\{\\s*${pair}(?:\\s*,\\s*${pair}){3}\\s*\\}\\s*$`).test(text))
    return deploymentFailure()
  const keys = [...text.matchAll(/"([A-Za-z]+)"\s*:/g)].map((match) => match[1])
  if (new Set(keys).size !== 4) return deploymentFailure()
  return parseStrategyInfrastructureReceipts(JSON.parse(text))
}

const wireBlock = (block: DeploymentBlock) => ({
  number: block.number.toString(),
  hash: block.hash,
  timestamp: block.timestamp.toString(),
})

async function assertCanonicalInfrastructureBlock(
  reader: StrategyDeploymentReader,
  block: DeploymentBlock,
) {
  const after = deploymentBlock(await reader.getBlock({ blockNumber: block.number }))
  if (
    after.number !== block.number ||
    after.hash !== block.hash ||
    after.timestamp !== block.timestamp ||
    (await reader.getChainId()) !== 56
  )
    return deploymentFailure()
}

/** Read-only receipt recovery. This observes protocol pins, it does not audit or approve them.
 * Only an operator may review and publish the returned candidate to API and worker. */
export async function finalizeStrategyInfrastructure(input: {
  owner: Hex
  receipts: unknown
  reader: StrategyDeploymentReader
  nowSeconds?: bigint
}) {
  try {
    if (!nonzeroAddress(input.owner)) return deploymentFailure()
    const owner = input.owner.toLowerCase() as Hex,
      receipts = parseStrategyInfrastructureReceipts(input.receipts),
      transactions = strategyInfrastructureTransactions(owner),
      reader = input.reader
    if ((await reader.getChainId()) !== 56) return deploymentFailure()
    const head = deploymentBlock(await reader.getBlock({ blockTag: 'finalized' }))
    const fresh = () => {
      const now = input.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))
      if (head.timestamp > now + 5n || now - head.timestamp > 120n) deploymentFailure()
    }
    fresh()
    const pin = async (address: Hex, blockNumber = head.number): Promise<StrategyCodePin> => {
      if (!nonzeroAddress(address)) return deploymentFailure()
      const code = await reader.getBytecode({ address, blockNumber })
      if (!code || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) return deploymentFailure()
      return { address: address.toLowerCase() as Hex, runtimeCodeHash: keccak256(code) }
    }
    const checkedInfrastructure = async (
      name: InfrastructureName,
      address: Hex,
      block: DeploymentBlock,
    ) => {
      const code = await reader.getBytecode({ address, blockNumber: block.number })
      assertStrategyArtifactRuntime(name, code)
      if (name !== 'StrategyBindingEnforcer') {
        if (
          !same(
            await deploymentRead(
              reader,
              block.number,
              address,
              'function manager() view returns (address)',
            ),
            mainnet.manager,
          ) ||
          !same(
            await deploymentRead(
              reader,
              block.number,
              address,
              'function accountRuntimeHash() view returns (bytes32)',
            ),
            reviewedStrategyAccountRuntimeHash(),
          )
        )
          return deploymentFailure()
      }
      return { address, runtimeCodeHash: keccak256(code) }
    }
    const evidence = [],
      pins = new Map<InfrastructureName, StrategyCodePin>(),
      blocks = new Map<bigint, DeploymentBlock>(),
      nonces = new Set<number>(),
      positions = new Set<string>()
    for (const expected of transactions) {
      const hash = receipts[expected.name]
      const receipt = deploymentObject(await reader.getTransactionReceipt({ hash }))
      if (
        !same(receipt.transactionHash, hash) ||
        receipt.status !== 'success' ||
        typeof receipt.blockNumber !== 'bigint' ||
        receipt.blockNumber < 1n ||
        receipt.blockNumber > head.number ||
        !nonzeroHash(receipt.blockHash) ||
        !same(receipt.from, owner) ||
        receipt.to !== null ||
        !nonzeroAddress(receipt.contractAddress) ||
        !Number.isSafeInteger(receipt.transactionIndex) ||
        (receipt.transactionIndex as number) < 0
      )
        return deploymentFailure()
      const position = `${receipt.blockNumber}:${receipt.transactionIndex}`
      if (positions.has(position)) return deploymentFailure()
      positions.add(position)
      const block = deploymentBlock(await reader.getBlock({ blockNumber: receipt.blockNumber }))
      if (
        block.number !== receipt.blockNumber ||
        !same(receipt.blockHash, block.hash) ||
        block.timestamp > head.timestamp
      )
        return deploymentFailure()
      const tx = deploymentObject(await reader.getTransaction({ hash }))
      if (
        !same(tx.hash, hash) ||
        !same(tx.blockHash, block.hash) ||
        tx.blockNumber !== block.number ||
        !same(tx.from, owner) ||
        tx.to !== null ||
        !same(tx.input, expected.data) ||
        tx.value !== 0n ||
        tx.chainId !== 56 ||
        !Number.isSafeInteger(tx.nonce) ||
        (tx.nonce as number) < 0 ||
        nonces.has(tx.nonce as number) ||
        tx.transactionIndex !== receipt.transactionIndex
      )
        return deploymentFailure()
      nonces.add(tx.nonce as number)
      const address = getContractAddress({
        from: owner,
        nonce: BigInt(tx.nonce as number),
      }).toLowerCase() as Hex
      if (
        !same(receipt.contractAddress, address) ||
        [...pins.values()].some((p) => p.address === address)
      )
        return deploymentFailure()
      const historical = await checkedInfrastructure(expected.name, address, block),
        current = await checkedInfrastructure(expected.name, address, head)
      if (historical.runtimeCodeHash !== current.runtimeCodeHash) return deploymentFailure()
      const previous = blocks.get(block.number)
      if (previous && (previous.hash !== block.hash || previous.timestamp !== block.timestamp))
        return deploymentFailure()
      blocks.set(block.number, block)
      pins.set(expected.name, current)
      evidence.push({
        name: expected.name,
        transactionHash: hash,
        address,
        nonce: String(tx.nonce),
        block: wireBlock(block),
        runtimeCodeHash: current.runtimeCodeHash,
      })
    }
    const readAddress = async (address: Hex, signature: string) => {
      const value = await deploymentRead(reader, head.number, address, signature)
      if (!nonzeroAddress(value)) return deploymentFailure()
      return value.toLowerCase() as Hex
    }
    const implementation = async (address: Hex) => {
      const value = await reader.getStorageAt({ address, slot: EIP1967, blockNumber: head.number })
      if (!value || !/^0x0{24}[0-9a-f]{40}$/i.test(value)) return deploymentFailure()
      return pin(`0x${value.slice(-40)}` as Hex)
    }
    const requiredPin = (name: InfrastructureName) => pins.get(name) ?? deploymentFailure()
    const candidate: StrategyDeploymentConfig = parseStrategyDeploymentConfig({
      version: 1,
      chainId: 56,
      manager: await pin(mainnet.manager as Hex),
      accountRuntimeHash: reviewedStrategyAccountRuntimeHash(),
      bindingEnforcer: requiredPin('StrategyBindingEnforcer'),
      factories: {
        yield: requiredPin('YieldVaultFactory'),
        grid: requiredPin('GridVaultFactory'),
        lp: requiredPin('LPVaultFactory'),
      },
      protocols: Object.fromEntries(
        await Promise.all(
          Object.entries(P).map(async ([key, address]) => [
            key,
            (await pin(address)).runtimeCodeHash,
          ]),
        ),
      ),
      poolDeployer: await pin(
        await readAddress(P.pancakeFactory, 'function poolDeployer() view returns (address)'),
      ),
      implementations: {
        venus: await pin(
          await readAddress(P.venus, 'function implementation() view returns (address)'),
        ),
        comptroller: await pin(
          await readAddress(
            P.comptroller,
            'function comptrollerImplementation() view returns (address)',
          ),
        ),
        aavePool: await implementation(P.aavePool),
        aaveReceipt: await implementation(P.aaveReceipt),
      },
      multicallRuntimeHash: (await pin(MULTICALL)).runtimeCodeHash,
    })
    await verifyStrategyDeploymentConfiguration(candidate, reader, { block: head })
    for (const block of blocks.values()) await assertCanonicalInfrastructureBlock(reader, block)
    await assertCanonicalInfrastructureBlock(reader, head)
    fresh()
    return {
      status: 'needs_operator_review' as const,
      warning:
        'Observed configuration candidate only, not an audit or publication. Independently review protocol and implementation pins, then verify-config again before explicitly configuring API and worker with this same configuration digest.',
      configuration: candidate,
      configurationDigest: strategyDeploymentConfigDigest(candidate),
      owner,
      checkpoint: wireBlock(head),
      receipts: evidence,
    }
  } catch {
    return {
      status: 'blocked' as const,
      reason:
        'Finalized reviewed infrastructure receipts or canonical protocol evidence are unavailable or inconsistent.',
    }
  }
}
