import { encodeAbiParameters, type Hex, keccak256, stringToHex } from 'viem'
import { nonzeroAddress, nonzeroHash } from './operation.js'

const READINESS_DOMAIN = keccak256(stringToHex('aiki.strategy-runner.readiness.v1'))

/** The public deployment digest remains unchanged; worker readiness also binds its signer. */
export function strategyRunnerReadinessDigest(configurationHash: Hex, executor: Hex): Hex {
  if (!nonzeroHash(configurationHash) || !nonzeroAddress(executor))
    throw new Error('Strategy readiness identity is unavailable.')
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }],
      [
        READINESS_DOMAIN,
        56n,
        configurationHash.toLowerCase() as Hex,
        executor.toLowerCase() as Hex,
      ],
    ),
  )
}
