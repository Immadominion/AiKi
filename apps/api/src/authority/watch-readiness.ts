import { DELEGATION_TYPES, delegationMessage } from '@aiki/contracts'
import { createPublicClient, hashStruct, http, type PublicClient, parseAbi } from 'viem'
import type { EnforcerDeployment } from '../config/enforcers.js'
import { ClientError } from '../http/errors.js'
import type { AuthorizationRecord } from '../jobs/store.js'
import { acceptDelegation } from './accept-delegation.js'

export type WatchMandateReadiness =
  | { ready: true }
  | { ready: false; reason: string; retryable: boolean }
export type WatchMandateVerifier = (
  authorization: AuthorizationRecord,
) => Promise<WatchMandateReadiness>

const ACCOUNT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function DELEGATION_MANAGER() view returns (address)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
])
const MANAGER_ABI = parseAbi([
  'function epochOf(address delegator) view returns (uint256)',
  'function isDisabled(bytes32 delegationHash) view returns (bool)',
])
const denied = (reason: string): WatchMandateReadiness => ({
  ready: false,
  reason,
  retryable: false,
})

/** Re-read authority before activation and each pass. This never signs or sends a transaction. */
export function createWatchMandateVerifier(
  input: { rpcUrl: string; deployment: EnforcerDeployment },
  suppliedClient?: Pick<PublicClient, 'getChainId' | 'readContract'>,
): WatchMandateVerifier {
  const { deployment } = input
  const client =
    suppliedClient ??
    createPublicClient({
      transport: http(input.rpcUrl, { timeout: 10_000, retryCount: 1 }),
    })
  return async (authorization) => {
    const delegation = authorization.delegation
    if (!delegation || !authorization.owner)
      return denied('Sign this mandate with the owner of the execution account first.')
    if (authorization.status !== 'active') return denied('This mandate is no longer active.')
    if (authorization.policy.expiresAt && Date.parse(authorization.policy.expiresAt) <= Date.now())
      return denied('This mandate has expired. Review and sign a new one.')
    if (authorization.delegationChainId !== deployment.chainId)
      return denied('This mandate belongs to a different execution network.')
    if (delegation.caveats.some((caveat) => caveat.args !== '0x'))
      return denied('This mandate contains unsupported execution arguments.')
    try {
      if ((await client.getChainId()) !== deployment.chainId)
        return denied('The execution RPC answers for a different network.')
      const manager = await client.readContract({
        address: delegation.delegator,
        abi: ACCOUNT_ABI,
        functionName: 'DELEGATION_MANAGER',
      })
      if (manager.toLowerCase() !== deployment.manager.toLowerCase())
        return denied(
          'This account uses a different execution manager. Set up an account for the current deployment before signing again.',
        )
      // Recompiles the original limits and asks ERC-1271 about the digest for
      // THIS manager. A signature for a retired manager must not pass readiness.
      await acceptDelegation({
        delegation,
        constraints: authorization.policy.constraints,
        owner: authorization.owner,
        deployment,
        chain: {
          ownerOf: async (account) =>
            client.readContract({
              address: account,
              abi: ACCOUNT_ABI,
              functionName: 'owner',
            }),
          isValidSignature: async (account, digest, signature) =>
            (
              await client.readContract({
                address: account,
                abi: ACCOUNT_ABI,
                functionName: 'isValidSignature',
                args: [digest, signature],
              })
            ).toLowerCase() === '0x1626ba7e',
        },
      })
      const managerAddress = deployment.manager as `0x${string}`
      const epoch = await client.readContract({
        address: managerAddress,
        abi: MANAGER_ABI,
        functionName: 'epochOf',
        args: [delegation.delegator],
      })
      if (epoch !== BigInt(delegation.epoch))
        return denied('This mandate was invalidated on chain. Review and sign a new one.')
      const delegationHash = hashStruct({
        data: delegationMessage(delegation),
        types: DELEGATION_TYPES,
        primaryType: 'Delegation',
      })
      const disabled = await client.readContract({
        address: managerAddress,
        abi: MANAGER_ABI,
        functionName: 'isDisabled',
        args: [delegationHash],
      })
      if (disabled) return denied('This mandate was revoked on chain.')
      return { ready: true }
    } catch (error) {
      if (error instanceof ClientError) return denied(error.message)
      // An RPC exception can contain its authenticated URL. Store only a safe,
      // actionable summary; a temporary outage must not discard the watch.
      return {
        ready: false,
        retryable: true,
        reason: 'The execution account could not be verified. No action was submitted.',
      }
    }
  }
}
