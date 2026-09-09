import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** Derive locally. Never include secret material or a library error in diagnostics. */
export function executorAddress(privateKey: string): Address {
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error()
    return privateKeyToAccount(privateKey as Hex).address
  } catch {
    throw new Error('AGENT_PRIVATE_KEY is not a valid executor key.')
  }
}

export function executorIdentity(env: Record<string, string | undefined>): {
  agentSessionKey?: Address
  agentKey?: Hex
} {
  const declared = env.AGENT_SESSION_ADDRESS?.trim()
  const privateKey = env.AGENT_PRIVATE_KEY?.trim()
  if (declared && (!/^0x[0-9a-fA-F]{40}$/.test(declared) || /^0x0+$/.test(declared)))
    throw new Error('AGENT_SESSION_ADDRESS must be a nonzero executor address.')
  if (!privateKey) return declared ? { agentSessionKey: declared.toLowerCase() as Address } : {}
  const derived = executorAddress(privateKey)
  if (declared && declared.toLowerCase() !== derived.toLowerCase())
    throw new Error(
      'AGENT_SESSION_ADDRESS does not match AGENT_PRIVATE_KEY. Execution is disabled.',
    )
  return { agentSessionKey: derived, agentKey: privateKey as Hex }
}

/** Deployment and redemption have separate durable queues and must never share a nonce space. */
export function accountFunderIdentity(env: Record<string, string | undefined>): {
  funderKey?: Hex
} {
  const key = env.ACCOUNT_FUNDER_PRIVATE_KEY?.trim()
  if (!key) return {}
  let funder: Address
  try {
    funder = executorAddress(key)
  } catch {
    throw new Error('ACCOUNT_FUNDER_PRIVATE_KEY is not a valid account-deployment key.')
  }
  const { agentSessionKey } = executorIdentity(env)
  if (agentSessionKey?.toLowerCase() === funder.toLowerCase())
    throw new Error(
      'Account deployment and execution must use different signing keys. Startup is disabled.',
    )
  return { funderKey: key as Hex }
}
