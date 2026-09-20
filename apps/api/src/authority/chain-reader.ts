import { type AccountToken, priceFeedsFor } from '@aiki/contracts'
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

  /**
   * Dollar prices for the assets an account can hold.
   *
   * A balance sits next to a decision about money, so the number beside it
   * comes from the same chain the balance does rather than from a price API.
   * A feed that cannot be read, or whose answer is older than its heartbeat,
   * is absent from the result: the caller then says "unpriced", which is true,
   * instead of a stale number, which is indistinguishable from a current one.
   */
  prices?(chainId: number): Promise<Record<string, number>>

  /**
   * What an arbitrary ERC-20 calls itself, so a mandate can name a token AiKi
   * has never heard of.
   *
   * The reviewed list is two tokens. An account can receive anything, and it
   * usually does: somebody who has been sent a token they want to use could not
   * write a mandate for it at all, which made their own money unreachable
   * through their own account.
   *
   * Read from the token rather than from a list, because there is no list that
   * could contain every token somebody might hold. Returns null when the
   * address does not answer like an ERC-20, which is the honest outcome for an
   * address that is not one.
   */
  token?(address: `0x${string}`): Promise<AccountToken | null>
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

const AGGREGATOR_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])
const ERC20_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)'])

const ERC20_META_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
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
    /*
     * Asked of the token itself, because no list could hold every token
     * somebody might be sent. A token that does not answer both calls is not
     * one a mandate can be denominated in: the caps are an amount of it, and an
     * amount needs decimals that came from somewhere real.
     */
    async token(address) {
      try {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address, abi: ERC20_META_ABI, functionName: 'symbol' }),
          client.readContract({ address, abi: ERC20_META_ABI, functionName: 'decimals' }),
        ])
        if (typeof decimals !== 'number' || decimals < 0 || decimals > 36) return null
        // Its own name, trimmed to something a screen can hold. A token is free
        // to call itself anything, including a sentence.
        const named = String(symbol ?? '')
          .trim()
          .slice(0, 16)
        return named ? { address, symbol: named, decimals } : null
      } catch {
        return null
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
    async prices(chainId) {
      const feeds = priceFeedsFor(chainId)
      const quotes = await Promise.all(
        feeds.map(async (feed) => {
          try {
            const [decimals, round] = await Promise.all([
              client.readContract({
                address: feed.address,
                abi: AGGREGATOR_ABI,
                functionName: 'decimals',
              }),
              client.readContract({
                address: feed.address,
                abi: AGGREGATOR_ABI,
                functionName: 'latestRoundData',
              }),
            ])
            const [, answer, , updatedAt] = round
            // A negative or zero answer is not a price, and an old one is not
            // this price. Either way the honest report is no report.
            if (answer <= 0n) return null
            const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt)
            if (ageSeconds < 0 || ageSeconds > feed.staleAfterSeconds) return null
            return [feed.symbol, Number(answer) / 10 ** Number(decimals)] as const
          } catch {
            return null
          }
        }),
      )
      return Object.fromEntries(quotes.filter((quote) => quote !== null))
    },
  }
}
