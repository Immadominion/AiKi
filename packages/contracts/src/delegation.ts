/**
 * The EIP-712 shape of a delegation, defined once for both sides.
 *
 * A user signs this in their wallet and a contract on BNB Chain checks the
 * signature. If the two disagree by one character the wallet produces a
 * signature the manager rejects, and the failure surfaces as an unexplained
 * revert at redemption rather than at signing time. So the strings live here,
 * in the package both sides compile against, and neither restates them.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 * `args` is deliberately NOT part of the Caveat type. The contract's typehash is
 * `Caveat(address enforcer,bytes terms)`, and args carry per-redemption data the
 * signature must not cover.
 *
 * The signature is not in the preimage either. If it were, flipping `s` would
 * produce a different delegation hash for the same delegation, and therefore a
 * fresh session-cap counter, and therefore unbounded spend.
 *
 * Verified against the deployed manager rather than assumed: `hashTypedData`
 * over these definitions and `getDelegationDigest` on chain 97 return the same
 * bytes, so an ordinary `eth_signTypedData_v4` from any wallet is accepted.
 */

export const DELEGATION_DOMAIN_NAME = 'AiKi Delegation'
export const DELEGATION_DOMAIN_VERSION = '1'

/** Matches `Constants.ROOT_AUTHORITY`: the only authority accepted in v1. */
export const ROOT_AUTHORITY = `0x${'ff'.repeat(32)}` as const

export const DELEGATION_TYPES = {
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
    { name: 'epoch', type: 'uint256' },
  ],
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
  ],
} as const

export interface DelegationCaveat {
  enforcer: `0x${string}`
  terms: `0x${string}`
  /** Per-redemption data. Outside the signature by design. */
  args: `0x${string}`
}

export interface UnsignedDelegation {
  /** The agent's session key. Only this address may redeem. */
  delegate: `0x${string}`
  /** The account the value lives in. Answers ERC-1271 for this signature. */
  delegator: `0x${string}`
  authority: `0x${string}`
  caveats: DelegationCaveat[]
  salt: string
  epoch: string
}

export interface SignedDelegation extends UnsignedDelegation {
  signature: `0x${string}`
}

/** The EIP-712 domain for a manager deployment. */
export const delegationDomain = (chainId: number, manager: `0x${string}`) => ({
  name: DELEGATION_DOMAIN_NAME,
  version: DELEGATION_DOMAIN_VERSION,
  chainId,
  verifyingContract: manager,
})

/**
 * The message a wallet is asked to sign.
 *
 * `args` is dropped here and nowhere else, so the one place it could wrongly
 * reach a signature is the one place it is removed.
 */
export const delegationMessage = (delegation: UnsignedDelegation) => ({
  delegate: delegation.delegate,
  delegator: delegation.delegator,
  authority: delegation.authority,
  caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
  salt: BigInt(delegation.salt),
  epoch: BigInt(delegation.epoch),
})
