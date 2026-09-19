import { type Address, createPublicClient, http, type PublicClient, parseAbi } from 'viem'
import { bsc } from 'viem/chains'
import { ReportInputError } from '../report-task.js'

const marketAbi = parseAbi([
  'function supplyRatePerBlock() view returns (uint256)',
  'function symbol() view returns (string)',
])
const WAD = 10n ** 18n
const BLOCKS_PER_YEAR = 70_080_000n // BSC measured 0.45s blocks; simple annualisation, not APY.
export interface YieldRoute {
  market: `0x${string}`
  symbol: string
  supplyRatePerBlock: string
  simpleAnnualRateBps: string
}
export interface YieldAssessment {
  category: 'yield_optimisation'
  assessmentVersion: 'venus-yield/v1'
  routes: YieldRoute[]
  recommendedMarket?: `0x${string}`
  recommendation: 'RATE_ONLY_CANDIDATE' | 'INSUFFICIENT_EVIDENCE'
  observedAt: string
  caveats: string[]
}
export function assessYield(
  routes: YieldRoute[],
  rateOnly: boolean,
  observedAt = new Date().toISOString(),
): YieldAssessment {
  const best = [...routes].sort((a, b) =>
    BigInt(b.simpleAnnualRateBps) > BigInt(a.simpleAnnualRateBps) ? 1 : -1,
  )[0]
  return {
    category: 'yield_optimisation',
    assessmentVersion: 'venus-yield/v1',
    routes,
    ...(rateOnly && best ? { recommendedMarket: best.market } : {}),
    recommendation: rateOnly && best ? 'RATE_ONLY_CANDIDATE' : 'INSUFFICIENT_EVIDENCE',
    observedAt,
    caveats: [
      'Rates are live Venus supply rates annualised linearly from BSC blocks; this is not realised APY.',
      'No risk, liquidity, gas, depeg, protocol, or withdrawal-delay comparison has been performed.',
      ...(rateOnly
        ? ['Rate-only mode is explicitly not an optimisation recommendation.']
        : ['Set rateOnly=true only to request a clearly labelled rate-only candidate.']),
    ],
  }
}
export interface YieldReader {
  assess(markets: `0x${string}`[], rateOnly: boolean): Promise<YieldAssessment>
}
/**
 * Named, so an answer can say WHICH market rather than that something failed.
 *
 * A Venus market answers supplyRatePerBlock and symbol. An address that does
 * not is either not a market or not a contract, and either way the person who
 * supplied it is the only one who can fix it. They cannot fix what they are not
 * told.
 */
export class UnreadableMarkets extends ReportInputError {
  constructor(readonly markets: `0x${string}`[]) {
    super(
      markets.length === 1
        ? `${markets[0]} does not answer as a Venus market, so it has no supply rate to report.`
        : `These do not answer as Venus markets, so they have no supply rate to report: ${markets.join(', ')}.`,
    )
    this.name = 'UnreadableMarkets'
  }
}

export class VenusYieldClient implements YieldReader {
  private readonly client: PublicClient
  constructor(rpcUrl: string, client?: PublicClient) {
    this.client = client ?? createPublicClient({ chain: bsc, transport: http(rpcUrl) })
  }
  async assess(markets: `0x${string}`[], rateOnly: boolean) {
    if (!markets.length) throw new Error('At least one Venus market is required.')
    /*
     * Which market failed, by name.
     *
     * Promise.all rejects with whichever read lost first, and the caller turned
     * that into "the on-chain read was unavailable". Measured: a buyer supplied
     * three markets, one was a valid address that is not a Venus market, and
     * the report came back blaming infrastructure. It read as an outage. It was
     * one wrong address out of three, and nothing in the answer said which.
     *
     * settled rather than all, so every market is tried and the ones that do
     * not answer are named together instead of one at a time.
     */
    const settled = await Promise.allSettled(
      markets.map(async (market) => {
        const [rateRaw, symbolRaw] = await Promise.all([
          this.client.readContract({
            address: market as Address,
            abi: marketAbi,
            functionName: 'supplyRatePerBlock',
          }),
          this.client.readContract({
            address: market as Address,
            abi: marketAbi,
            functionName: 'symbol',
          }),
        ])
        const rate = rateRaw as bigint
        return {
          market,
          symbol: symbolRaw as string,
          supplyRatePerBlock: rate.toString(),
          simpleAnnualRateBps: ((rate * BLOCKS_PER_YEAR * 10_000n) / WAD).toString(),
        }
      }),
    )
    const unreadable = markets.filter((_market, index) => settled[index]?.status === 'rejected')
    if (unreadable.length) throw new UnreadableMarkets(unreadable)
    const routes = settled.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []))
    return assessYield(routes, rateOnly)
  }
}
