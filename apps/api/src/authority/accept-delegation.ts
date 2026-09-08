import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  ROOT_AUTHORITY,
  type SignedDelegation,
} from '@aiki/contracts'
import { hashTypedData } from 'viem'
import type { EnforcerDeployment } from '../config/enforcers.js'
import { ClientError } from '../http/errors.js'
import { compileCaveats } from './caveats.js'
import type { ChainReader } from './chain-reader.js'
import type { Constraint } from './policy.js'

/**
 * Decide whether a signed delegation may be filed against a mandate.
 *
 * The point of the whole product is that the limits a person saw are the limits
 * the chain will hold. Between those two moments sits a signature, and every
 * refusal here is one of the ways that could stop being true.
 *
 * The one that matters most is the caveat comparison. A caller posts the
 * constraints, sees a mandate, and then posts a signed delegation; nothing makes
 * those the same object. Without recompiling the stored constraints and
 * demanding the delegation match them byte for byte, somebody could be shown a
 * ten dollar cap, sign a ten thousand dollar one, and have AiKi file it as the
 * mandate they agreed to. It would look correct on every screen.
 */

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export interface AcceptedDelegation {
  delegation: SignedDelegation
  digest: `0x${string}`
  chainId: number
}

export async function acceptDelegation(input: {
  delegation: SignedDelegation
  /** The constraints already stored against this mandate. Not the caller's copy. */
  constraints: Constraint[]
  /** The address that proved control of a wallet by signing in. */
  owner: string
  deployment: EnforcerDeployment
  chain: ChainReader
}): Promise<AcceptedDelegation> {
  const { delegation, constraints, owner, deployment, chain } = input

  if (!delegation || typeof delegation !== 'object')
    throw new ClientError('A signed delegation is required.', { code: 'DELEGATION_MALFORMED' })
  if (typeof delegation.signature !== 'string' || !delegation.signature.startsWith('0x'))
    throw new ClientError('The delegation carries no signature.', { code: 'DELEGATION_UNSIGNED' })

  // v1 accepts one authority, and the manager will refuse anything else at
  // redemption. Refusing here means it is refused while somebody is watching.
  if (!sameHex(delegation.authority ?? '', ROOT_AUTHORITY))
    throw new ClientError('This delegation does not use the root authority.', {
      code: 'DELEGATION_AUTHORITY',
    })

  if (!delegation.delegate || sameHex(delegation.delegate, `0x${'00'.repeat(20)}`))
    throw new ClientError('A delegation must name the agent that may redeem it.', {
      code: 'DELEGATION_NO_DELEGATE',
    })

  /*
   * The mandate that was signed must be the mandate that was agreed. Recompiled
   * from what is stored rather than compared against anything the caller sent
   * alongside the signature, because a caller who can choose both sides of a
   * comparison is not being checked by it.
   */
  const { caveats } = compileCaveats(constraints, deployment)
  if (delegation.caveats?.length !== caveats.length)
    throw new ClientError('This delegation does not carry the limits of this mandate.', {
      code: 'DELEGATION_CAVEAT_MISMATCH',
    })
  for (const [i, expected] of caveats.entries()) {
    const given = delegation.caveats[i]
    if (
      !given ||
      !sameHex(given.enforcer, expected.enforcer) ||
      !sameHex(given.terms, expected.terms)
    )
      throw new ClientError('This delegation does not carry the limits of this mandate.', {
        code: 'DELEGATION_CAVEAT_MISMATCH',
      })
  }

  /*
   * The account the value comes out of has to be one this person owns. The
   * signature alone does not establish that: a delegation naming somebody else's
   * account, signed by nobody in particular, would otherwise be filed against
   * this mandate and look exactly like a real one until it was redeemed.
   */
  const accountOwner = await chain.ownerOf(delegation.delegator)
  if (!accountOwner)
    throw new ClientError('That account does not exist on this chain.', {
      code: 'DELEGATOR_UNKNOWN',
    })
  if (!sameHex(accountOwner, owner))
    throw new ClientError('That account belongs to somebody else.', {
      code: 'DELEGATOR_NOT_YOURS',
    })

  /*
   * Ask the account, not ourselves. The delegator is a contract, so it is the
   * authority on what its owner signed, and asking it directly means a smart
   * account with an unfamiliar signing scheme works without this code knowing
   * anything about it.
   */
  const digest = hashTypedData({
    domain: delegationDomain(deployment.chainId, deployment.manager as `0x${string}`),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: delegationMessage(delegation),
  })
  if (!(await chain.isValidSignature(delegation.delegator, digest, delegation.signature)))
    throw new ClientError('That account does not accept this signature.', {
      code: 'DELEGATION_SIGNATURE_REJECTED',
    })

  return { delegation, digest, chainId: deployment.chainId }
}
