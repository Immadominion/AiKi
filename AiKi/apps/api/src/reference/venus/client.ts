import { type Address, createPublicClient, http, type PublicClient, parseAbi } from 'viem'
import { bsc } from 'viem/chains'
import { BSC_MAINNET } from '../../config/chains.js'
import {
  type VenusAccountSnapshot,
  type VenusHealthAssessment,
  type VenusMarketSnapshot,
  type VenusPosition,
  WAD,
} from './types.js'

const comptrollerAbi = parseAbi([
  'function getAccountLiquidity(address account) view returns (uint256 errCode, uint256 liquidity, uint256 shortfall)',
  'function getAssetsIn(address account) view returns (address[])',
  'function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus)',
  'function oracle() view returns (address)',
])
const vTokenAbi = parseAbi([
  'function getAccountSnapshot(address account) view returns (uint256 errCode, uint256 vTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa)',
])
const oracleAbi = parseAbi(['function getUnderlyingPrice(address vToken) view returns (uint256)'])

const amount = (value: bigint) => ({
  amount: value.toString(),
  asset: 'USD' as const,
  decimals: 18 as const,
})
const abs = (value: bigint) => (value < 0n ? -value : value)

function decimal18(value: string): bigint {
  if (!/^\d+(?:\.\d{1,18})?$/.test(value))
    throw new Error('minimumHealthFactor must be a non-negative decimal with at most 18 places.')
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * WAD + BigInt(`${fraction}${'0'.repeat(18 - fraction.length)}`)
}

function ratio(value: bigint): string {
  const whole = value / WAD
  const fraction = (value % WAD).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function position(market: VenusMarketSnapshot): {
  output: VenusPosition
  supplied: bigint
  adjustedCollateral: bigint
  borrowed: bigint
} {
  const supplied =
    (market.vTokenBalance * market.exchangeRate * market.underlyingPrice) / (WAD * WAD)
  const borrowed = (market.borrowBalance * market.underlyingPrice) / WAD
  const adjustedCollateral = (supplied * market.collateralFactor) / WAD
  return {
    output: {
      vToken: market.vToken,
      collateralFactor: ratio(market.collateralFactor),
      supplied: amount(supplied),
      borrowed: amount(borrowed),
      adjustedCollateral: amount(adjustedCollateral),
    },
    supplied,
    adjustedCollateral,
    borrowed,
  }
}

/** Derives a health factor and cross-checks its surplus/shortfall with Venus Comptroller. */
export function assessVenusSnapshot(
  snapshot: VenusAccountSnapshot,
  minimumHealthFactor = '1.25',
): VenusHealthAssessment {
  const threshold = decimal18(minimumHealthFactor)
  const derived = snapshot.markets.map(position)
  const supplied = derived.reduce((total, item) => total + item.supplied, 0n)
  const adjustedCollateral = derived.reduce((total, item) => total + item.adjustedCollateral, 0n)
  const borrowed = derived.reduce((total, item) => total + item.borrowed, 0n)
  const expectedLiquidity = adjustedCollateral >= borrowed ? adjustedCollateral - borrowed : 0n
  const expectedShortfall = borrowed > adjustedCollateral ? borrowed - adjustedCollateral : 0n
  const controllerDelta =
    abs(expectedLiquidity - snapshot.controllerLiquidity) +
    abs(expectedShortfall - snapshot.controllerShortfall)
  // Oracle rounding and interest accrual may differ by a few wei; more than one cent is material.
  const consistent = controllerDelta <= 10n ** 16n
  const healthFactor = borrowed > 0n ? (adjustedCollateral * WAD) / borrowed : undefined
  const status = !consistent
    ? 'INCONSISTENT'
    : snapshot.markets.length === 0
      ? 'NO_POSITION'
      : borrowed === 0n
        ? 'NO_DEBT'
        : snapshot.controllerShortfall > 0n
          ? 'LIQUIDATABLE'
          : healthFactor !== undefined && healthFactor < threshold
            ? 'AT_RISK'
            : 'SAFE'

  return {
    account: snapshot.account,
    protocol: 'Venus',
    category: 'health_factor',
    assessmentVersion: 'venus-health/v1',
    observedAt: snapshot.observedAt,
    status,
    minimumHealthFactor,
    ...(healthFactor === undefined ? {} : { healthFactor: ratio(healthFactor) }),
    supplied: amount(supplied),
    adjustedCollateral: amount(adjustedCollateral),
    borrowed: amount(borrowed),
    controllerLiquidity: amount(snapshot.controllerLiquidity),
    controllerShortfall: amount(snapshot.controllerShortfall),
    positions: derived.map((item) => item.output),
    methodology:
      'Venus Comptroller entered markets × exchange rates × oracle prices × collateral factors; cross-checked against getAccountLiquidity.',
    consistency: consistent
      ? {
          verified: true,
          detail:
            'Derived surplus/shortfall agrees with Venus Comptroller within one cent of oracle rounding.',
        }
      : {
          verified: false,
          detail: `Derived and controller liquidity differ by ${controllerDelta.toString()} 18-decimal USD units; no automation decision should use this assessment.`,
        },
    caveats: [
      'Read-only assessment: no repayment, swap, or transaction is initiated.',
      'Health factor is computed from the account’s currently entered Venus markets at the observed block state.',
    ],
  }
}

export interface VenusReader {
  snapshot(account: Address): Promise<VenusAccountSnapshot>
}

export class VenusClient implements VenusReader {
  private readonly client: PublicClient
  constructor(rpcUrl: string, client?: PublicClient) {
    this.client = client ?? createPublicClient({ chain: bsc, transport: http(rpcUrl) })
  }

  async snapshot(account: Address): Promise<VenusAccountSnapshot> {
    const comptroller = BSC_MAINNET.contracts.venusComptroller as Address
    const [liquidityResultRaw, assetsRaw, oracleRaw] = await Promise.all([
      this.client.readContract({
        address: comptroller,
        abi: comptrollerAbi,
        functionName: 'getAccountLiquidity',
        args: [account],
      }),
      this.client.readContract({
        address: comptroller,
        abi: comptrollerAbi,
        functionName: 'getAssetsIn',
        args: [account],
      }),
      this.client.readContract({
        address: comptroller,
        abi: comptrollerAbi,
        functionName: 'oracle',
      }),
    ])
    const liquidityResult = liquidityResultRaw as readonly [bigint, bigint, bigint]
    const assets = assetsRaw as readonly Address[]
    const oracle = oracleRaw as Address
    if (liquidityResult[0] !== 0n)
      throw new Error(`Venus Comptroller returned error code ${liquidityResult[0].toString()}.`)
    const markets = await Promise.all(
      assets.map(async (vToken): Promise<VenusMarketSnapshot> => {
        const [marketRaw, accountSnapshotRaw, underlyingPriceRaw] = await Promise.all([
          this.client.readContract({
            address: comptroller,
            abi: comptrollerAbi,
            functionName: 'markets',
            args: [vToken],
          }),
          this.client.readContract({
            address: vToken,
            abi: vTokenAbi,
            functionName: 'getAccountSnapshot',
            args: [account],
          }),
          this.client.readContract({
            address: oracle,
            abi: oracleAbi,
            functionName: 'getUnderlyingPrice',
            args: [vToken],
          }),
        ])
        const market = marketRaw as readonly [boolean, bigint, boolean]
        const accountSnapshot = accountSnapshotRaw as readonly [bigint, bigint, bigint, bigint]
        const underlyingPrice = underlyingPriceRaw as bigint
        if (!market[0]) throw new Error(`Venus returned a non-listed entered market: ${vToken}.`)
        if (accountSnapshot[0] !== 0n)
          throw new Error(
            `Venus vToken ${vToken} returned snapshot error ${accountSnapshot[0].toString()}.`,
          )
        return {
          vToken,
          collateralFactor: market[1],
          vTokenBalance: accountSnapshot[1],
          borrowBalance: accountSnapshot[2],
          exchangeRate: accountSnapshot[3],
          underlyingPrice,
        }
      }),
    )
    return {
      account,
      observedAt: new Date().toISOString(),
      controllerLiquidity: liquidityResult[1],
      controllerShortfall: liquidityResult[2],
      markets,
    }
  }

  async assess(account: Address, minimumHealthFactor?: string): Promise<VenusHealthAssessment> {
    return assessVenusSnapshot(await this.snapshot(account), minimumHealthFactor)
  }
}
