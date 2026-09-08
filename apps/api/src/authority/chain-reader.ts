import { createPublicClient, http, parseAbi } from 'viem'

/**
 * The two things the API must ask a chain before it will store a delegation.
 *
 * Kept as an interface rather than a viem client so the refusals can be tested
 * without a network. Every one of them is a rule about somebody else's money,
 * and a rule that is only exercised against a live testnet is a rule that stops
 * being exercised the first time the RPC is slow.
 */
export interface ChainReader {
  /**
   * Who owns a mandate account.
   *
   * A delegation names the account its value comes out of. Without this check
   * anyone could attach a signed delegation naming an account they do not own,
   * and the API would file it against their own authorization.
   */
  ownerOf(account: `0x${string}`): Promise<`0x${string}` | null>

  /**
   * Whether the account itself accepts this signature, by ERC-1271.
   *
   * The delegator is a contract, so the account is the authority on what its
   * owner signed, not us. Asking it directly also means a smart account with a
   * different signing scheme works without this code knowing anything about it.
   */
  isValidSignature(
    account: `0x${string}`,
    digest: `0x${string}`,
    signature: `0x${string}`,
  ): Promise<boolean>
}

const ACCOUNT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
])

/** ERC-1271's accept value. Anything else, including a revert, is a refusal. */
const MAGIC = '0x1626ba7e'

export function viemChainReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl) })
  return {
    async ownerOf(account) {
      try {
        return await client.readContract({
          address: account,
          abi: ACCOUNT_ABI,
          functionName: 'owner',
        })
      } catch {
        // Not an account we understand, or no code at all. Either way it is not
        // something a mandate may be filed against.
        return null
      }
    },
    async isValidSignature(account, digest, signature) {
      try {
        const answer = await client.readContract({
          address: account,
          abi: ACCOUNT_ABI,
          functionName: 'isValidSignature',
          args: [digest, signature],
        })
        return answer.toLowerCase() === MAGIC
      } catch {
        // AiKiMandateAccount returns 0xffffffff rather than reverting, but a
        // different account may revert, and a revert is a no.
        return false
      }
    },
  }
}
