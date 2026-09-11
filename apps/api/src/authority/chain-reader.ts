import type { AccountToken } from '@aiki/contracts'
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

  /**
   * What a mandate account holds, so a person can be told whether funding it
   * worked.
   *
   * Optional because it is the only method here that is not load-bearing for a
   * refusal: a deployment that cannot reach an RPC must still be able to store
   * and check delegations, and an unknown balance is reported as unknown rather
   * than as zero. Zero and "could not read" look identical on a screen and mean
   * opposite things to somebody who has just sent money.
   */
  balances?(account: `0x${string}`, tokens: AccountToken[]): Promise<AccountBalances>
}

/** Base units as decimal strings. A balance is money; it never becomes a float. */
export interface TokenBalance {
  address: `0x${string}`
  symbol: string
  decimals: number
  raw: string
}

export interface AccountBalances {
  /** Wei. Spendable by the owner only: no delegation can move native value. */
  native: string
  tokens: TokenBalance[]
}

const ACCOUNT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
])

const ERC20_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)'])

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
    /*
     * All of it, or none of it. A partial list reads as complete to whoever is
     * looking at it, so one unreadable token is reported by failing the whole
     * call and letting the caller say "unknown" rather than by quietly dropping
     * a row somebody's money might be sitting in.
     */
    async balances(account, tokens) {
      const [native, held] = await Promise.all([
        client.getBalance({ address: account }),
        Promise.all(
          tokens.map(async (token) => ({
            ...token,
            raw: (
              await client.readContract({
                address: token.address,
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: [account],
              })
            ).toString(),
          })),
        ),
      ])
      return { native: native.toString(), tokens: held }
    },
  }
}
