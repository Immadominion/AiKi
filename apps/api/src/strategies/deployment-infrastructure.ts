import { concatHex, encodeAbiParameters, type Hex, keccak256 } from 'viem'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { STRATEGY_DEPLOYMENT_ARTIFACTS as A } from './deployment-artifacts.js'
import { reviewedStrategyAccountRuntimeHash } from './deployment-config.js'
import {
  assertCanonicalDeploymentBlock,
  deploymentBlock,
  deploymentFailure,
} from './deployment-verification.js'
import { nonzeroAddress } from './operation.js'
import type { StrategySnapshotReader } from './snapshot.js'

/** Public unsigned CREATE data only. No nonce or predicted CREATE address is guessed.
 * Deployments are separate explicit wallet transactions; no funding/start occurs here. */
export function strategyInfrastructureTransactions(owner: Hex) {
  if (!nonzeroAddress(owner)) return deploymentFailure()
  const accountRuntimeHash = reviewedStrategyAccountRuntimeHash()
  return (
    ['StrategyBindingEnforcer', 'YieldVaultFactory', 'GridVaultFactory', 'LPVaultFactory'] as const
  ).map((name) => {
    const artifact = A[name]
    const args =
      name === 'StrategyBindingEnforcer'
        ? '0x'
        : encodeAbiParameters(
            [{ type: 'address' }, { type: 'bytes32' }],
            [mainnet.manager as Hex, accountRuntimeHash],
          )
    const data = concatHex([artifact.creationCode, args])
    return {
      name,
      chainId: 56 as const,
      from: owner.toLowerCase() as Hex,
      value: '0' as const,
      data,
      creationCodeHash: keccak256(artifact.creationCode),
      accountRuntimeHash,
      manager: mainnet.manager,
      warning:
        'Unsigned contract creation only. Wallet must omit to. After finality, record actual receipt addresses and review exact deployed runtime pins before configuring strategy setup.',
    }
  })
}
export async function prepareStrategyInfrastructure(input: {
  owner: Hex
  reader: StrategySnapshotReader
  nowSeconds?: bigint
}) {
  try {
    const transactions = strategyInfrastructureTransactions(input.owner)
    if ((await input.reader.getChainId()) !== 56) return deploymentFailure()
    const block = deploymentBlock(await input.reader.getBlock({ blockTag: 'finalized' }))
    const now = input.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))
    if (block.timestamp > now + 5n || now - block.timestamp > 120n) return deploymentFailure()
    const code = await input.reader.getBytecode({
      address: mainnet.manager as Hex,
      blockNumber: block.number,
    })
    if (!code || keccak256(code) !== mainnet.managerCodeHash) return deploymentFailure()
    await assertCanonicalDeploymentBlock(input.reader, block)
    return {
      status: 'prepared' as const,
      block: {
        number: block.number.toString(),
        hash: block.hash,
        timestamp: block.timestamp.toString(),
      },
      transactions,
    }
  } catch {
    return {
      status: 'blocked' as const,
      reason: 'Reviewed mainnet infrastructure could not be verified.',
    }
  }
}
