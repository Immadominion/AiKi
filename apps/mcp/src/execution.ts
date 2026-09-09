import { type ExecutionNetwork, parseExecutionNetwork } from '@aiki/contracts'
import type { AikiClient } from './client.js'

/** Public metadata is read afresh, including before authentication. Never infer a fallback chain. */
export async function executionNetwork(client: AikiClient): Promise<ExecutionNetwork> {
  return parseExecutionNetwork(await client.get<unknown>('/v1/execution/network'))
}

export function executionAccount(
  value: unknown,
  network: ExecutionNetwork,
  required = false,
): { address: `0x${string}` | null; chainId: 56 | 97 } {
  const account = value as { address?: unknown; chainId?: unknown } | null
  if (
    !account ||
    account.chainId !== network.chainId ||
    (account.address !== null &&
      (typeof account.address !== 'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(account.address) ||
        /^0x0{40}$/.test(account.address))) ||
    (required && account.address === null)
  )
    throw new Error(
      'The mandate account does not match the verified execution network. No signature or watch was submitted.',
    )
  return { address: account.address as `0x${string}` | null, chainId: network.chainId }
}

export function executionRpc(chainId: 56 | 97): string {
  return chainId === 56
    ? 'https://bsc-dataseed.bnbchain.org'
    : 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
}
