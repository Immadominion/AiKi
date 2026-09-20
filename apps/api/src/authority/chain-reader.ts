import { type AccountToken, priceFeedsFor } from '@aiki/contracts'
import { createPublicClient, http, namehash, parseAbi } from 'viem'

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
   * A .bnb name to the address it points at, or null.
   *
   * Space ID's registry on BSC is ENS-shaped: namehash the name, ask the
   * registry which resolver owns that node, ask the resolver for the address.
   * Null covers every way this can not-answer - unregistered, registered with
   * no address set, an unreachable node - because all of them mean the same
   * thing to somebody about to send money, which is "do not send it yet".
   */
  resolveName?(name: string): Promise<`0x${string}` | null>

  /** What `spender` may already move of `owner`'s `token`, in base units. */
  allowance?(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<string>

  /**
   * The best price the reviewed venue will give, across its fee tiers.
   *
   * Quoted rather than assumed, and quoted for every tier because the cheapest
   * fee is not always the best fill: a thin pool at 0.01% can pay less than a
   * deep one at 0.25%. A tier with no pool reverts, which is an answer and not
   * an error.
   */
  quoteSwap?(input: {
    tokenIn: `0x${string}`
    tokenOut: `0x${string}`
    amountIn: bigint
  }): Promise<{ amountOut: string; fee: number } | null>

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

/** Space ID's .bnb registry on BNB Smart Chain. ENS-shaped, verified resolving live names. */
const SID_REGISTRY = '0x08ced32a7f3eec915ba84415e9c07a7286977956' as const
const SID_ABI = parseAbi([
  'function resolver(bytes32 node) view returns (address)',
  'function addr(bytes32 node) view returns (address)',
])
/** PancakeSwap V3's QuoterV2 on BSC, and the fee tiers its factory enables. */
const PANCAKE_QUOTER = '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997' as const
const PANCAKE_FEE_TIERS = [100, 500, 2500, 10_000] as const
const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
])
const AGGREGATOR_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

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
    async allowance(token, owner, spender) {
      return (
        await client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [owner, spender],
        })
      ).toString()
    },
    async quoteSwap({ tokenIn, tokenOut, amountIn }) {
      if (amountIn <= 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null
      const quotes = await Promise.all(
        PANCAKE_FEE_TIERS.map(async (fee) => {
          try {
            const [amountOut] = await client
              .simulateContract({
                address: PANCAKE_QUOTER,
                abi: QUOTER_ABI,
                functionName: 'quoteExactInputSingle',
                args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
              })
              .then((result) => result.result as readonly [bigint, bigint, number, bigint])
            return amountOut > 0n ? { amountOut, fee } : null
          } catch {
            // No pool at this tier. Not a failure, just not a route.
            return null
          }
        }),
      )
      const best = quotes
        .filter((quote) => quote !== null)
        .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0]
      return best ? { amountOut: best.amountOut.toString(), fee: best.fee } : null
    },
    async resolveName(name) {
      const lower = name.trim().toLowerCase()
      // Only .bnb, and only a shape that is a name. Anything else is either
      // already an address or something this cannot speak for.
      if (!/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.bnb$/.test(lower)) return null
      try {
        const node = namehash(lower)
        const resolver = await client.readContract({
          address: SID_REGISTRY,
          abi: SID_ABI,
          functionName: 'resolver',
          args: [node],
        })
        if (!resolver || /^0x0{40}$/i.test(resolver)) return null
        const address = await client.readContract({
          address: resolver,
          abi: SID_ABI,
          functionName: 'addr',
          args: [node],
        })
        // A registered name with no address set resolves to zero. Sending
        // there destroys the money, so it is not an answer.
        if (!address || /^0x0{40}$/i.test(address)) return null
        return address.toLowerCase() as `0x${string}`
      } catch {
        return null
      }
    },
  }
}
