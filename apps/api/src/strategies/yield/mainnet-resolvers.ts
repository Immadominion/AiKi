import { ceilDiv, YIELD_RAY as R, YIELD_WAD as U } from './rates.js'
import {
  YIELD_READ_ADDRESSES as A,
  type YieldResolverContext,
  type YieldSnapshotResolvers,
} from './snapshot.js'
import type {
  YieldAddress,
  YieldHash,
  YieldRateModel,
  YieldSnapshot,
  YieldVenusTwoKinksModel,
} from './types.js'

/** Reviewed at BSC block 121004566 (2026-09-10), no configurable arbitrary model/price targets.
 * Venus deployment artifacts + exact source:
 * https://github.com/VenusProtocol/venus-protocol/tree/develop/deployments/bscmainnet
 * https://github.com/VenusProtocol/venus-protocol/blob/develop/contracts/Utils/CheckpointView.sol
 * https://github.com/VenusProtocol/venus-protocol/blob/develop/contracts/InterestRateModels/TwoKinksInterestRateModel.sol
 * Aave addresses and exact ray/percentage arithmetic:
 * https://github.com/aave-dao/aave-address-book/blob/main/src/ts/AaveV3BNB.ts
 * https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/misc/DefaultReserveInterestRateStrategyV2.sol
 * Chainlink's published BSC reference feed directory (standard feeds, not SVR):
 * https://reference-data-directory.vercel.app/feeds-bsc-mainnet.json
 * These are review pins, not runtime trust-on-first-use. Any replacement fails closed.
 */
export const YIELD_MAINNET_REVIEW = {
  block: 121_004_566n,
  venusWrapper: {
    address: '0x2cf0e211c99dfd28892cf80d142aa27a9042dbf4',
    runtimeHash: '0x96317faaeddff42fb34664eb4c3a211b24a6fcc7d9db53b295d376943a02e38e',
  },
  venusModel: {
    address: '0x857ebb8cacb97de5ab719320c9fb3aa16076bfe3',
    runtimeHash: '0x576a3e3b3d70c693838e75941cca792cd4f1b21fcd93b9fa805d9f0b89afabcc',
  },
  venusPreviousModel: '0x1aaade04a970043756d90e11af57e03a3a10e2c4',
  checkpointTimestamp: 1_768_357_800,
  aaveModel: {
    address: '0x86ab1c62a8bf868e1b3e1ab87d587aba6fbcbdc5',
    runtimeHash: '0xa1248aabbc6694f517cee69d97494977c9cba74dc18f8665c507c9f73fbfe0d7',
  },
  bnbFeed: {
    address: '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee',
    runtimeHash: '0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2',
    aggregator: '0xa6e8fee84f9bd528ad71917c9ddbb1fd3214f280',
    aggregatorHash: '0x16f41184f797cb8f8918680df0ebf2a97cc3192aa6b104615f61096fc674f2aa',
    description: 'BNB / USD',
    maxAgeSeconds: 90,
  },
  usdtFeed: {
    address: '0xb97ad0e74fa7d920791e90258a6e2085088b4320',
    runtimeHash: '0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2',
    aggregator: '0x63f4ff1c8c16c312f4b9792bdfde149622293934',
    aggregatorHash: '0xec635dff6a4204a0de141a9a6728b9c84995894680d703e44ac0057ffb38c412',
    description: 'USDT / USD',
    maxAgeSeconds: 930,
  },
} as const

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const int = (v: unknown): bigint => {
  if (typeof v !== 'bigint' || v <= -(2n ** 255n) || v >= 2n ** 255n)
    throw new Error('Unsupported model data')
  return v
}
const unsigned = (v: unknown): bigint => {
  const n = int(v)
  if (n < 0n) throw new Error('Unsupported unsigned data')
  return n
}
const tuple = (v: unknown, length: number): readonly unknown[] => {
  if (!Array.isArray(v) || v.length !== length) throw new Error('Unsupported tuple data')
  return v
}
async function pin(
  ctx: YieldResolverContext,
  expected: { address: YieldAddress; runtimeHash: YieldHash },
) {
  if (!same(await ctx.codeHash(expected.address), expected.runtimeHash))
    throw new Error('Unreviewed code')
}

async function venus(ctx: YieldResolverContext): Promise<YieldVenusTwoKinksModel | null> {
  const p = YIELD_MAINNET_REVIEW
  await Promise.all([pin(ctx, p.venusWrapper), pin(ctx, p.venusModel)])
  const [current, first, second, checkpoint] = await Promise.all([
    ctx.read(p.venusWrapper.address, 'function currentDataSource() view returns(address)'),
    ctx.read(p.venusWrapper.address, 'function DATA_SOURCE_1() view returns(address)'),
    ctx.read(p.venusWrapper.address, 'function DATA_SOURCE_2() view returns(address)'),
    ctx.read(p.venusWrapper.address, 'function CHECKPOINT_TIMESTAMP() view returns(uint256)'),
  ])
  if (
    !same(current, p.venusModel.address) ||
    !same(first, p.venusPreviousModel) ||
    !same(second, p.venusModel.address) ||
    unsigned(checkpoint) !== BigInt(p.checkpointTimestamp) ||
    ctx.block.timestamp <= p.checkpointTimestamp ||
    ctx.block.number < 4096n
  )
    return null
  const sample = await ctx.blockAt(ctx.block.number - 4096n)
  const seconds = ctx.block.timestamp - sample.timestamp
  if (
    sample.number !== ctx.block.number - 4096n ||
    sample.timestamp <= p.checkpointTimestamp ||
    seconds < 300 ||
    seconds > 86_400
  )
    return null
  const names = [
    'BASE_RATE_PER_BLOCK',
    'MULTIPLIER_PER_BLOCK',
    'KINK_1',
    'MULTIPLIER_2_PER_BLOCK',
    'BASE_RATE_2_PER_BLOCK',
    'KINK_2',
    'JUMP_MULTIPLIER_PER_BLOCK',
    'RATE_1',
    'RATE_2',
    'BLOCKS_PER_YEAR',
  ] as const
  const params = await Promise.all(
    names.map((name) => ctx.read(p.venusModel.address, `function ${name}() view returns(int256)`)),
  )
  // Immutable constructor values are independently bound by runtime code, and checked here
  // so corrupted data cannot masquerade as a reviewed signed/unsigned curve.
  const expected = [
    0n,
    934306370n,
    840000000000000000n,
    3567351597n,
    0n,
    920000000000000000n,
    57969463470n,
    784817350n,
    285388127n,
    70080000n,
  ]
  if (params.some((value, i) => int(value) !== expected[i])) return null
  const [
    baseBorrowRate,
    multiplierPerBlock,
    kink1Wad,
    multiplier2PerBlock,
    baseRate2PerBlock,
    kink2Wad,
    jumpMultiplierPerBlock,
    rate1,
    rate2,
    blocksPerYear,
  ] = params.map(int)
  if (
    [
      baseBorrowRate,
      multiplierPerBlock,
      kink1Wad,
      multiplier2PerBlock,
      baseRate2PerBlock,
      kink2Wad,
      jumpMultiplierPerBlock,
      rate1,
      rate2,
      blocksPerYear,
    ].some((v) => v === undefined)
  )
    return null
  return {
    kind: 'venus-two-kinks',
    address: p.venusWrapper.address,
    runtimeHash: p.venusWrapper.runtimeHash,
    verified: true,
    implementation: p.venusModel.address,
    implementationHash: p.venusModel.runtimeHash,
    clock: {
      kind: 'per-block',
      scale: U,
      verifiedOnchain: true,
      sampleStartBlock: sample.number,
      sampleStartTimestamp: sample.timestamp,
    },
    baseBorrowRate: int(baseBorrowRate),
    multiplierPerBlock: int(multiplierPerBlock),
    kink1Wad: int(kink1Wad),
    multiplier2PerBlock: int(multiplier2PerBlock),
    baseRate2PerBlock: int(baseRate2PerBlock),
    kink2Wad: int(kink2Wad),
    jumpMultiplierPerBlock: int(jumpMultiplierPerBlock),
    rate1: int(rate1),
    rate2: int(rate2),
    blocksPerYear: int(blocksPerYear),
  }
}

async function aave(ctx: YieldResolverContext): Promise<YieldRateModel | null> {
  const p = YIELD_MAINNET_REVIEW.aaveModel
  await pin(ctx, p)
  const [provider, data] = await Promise.all([
    ctx.read(p.address, 'function ADDRESSES_PROVIDER() view returns(address)'),
    ctx.read(
      p.address,
      'function getInterestRateData(address) view returns(uint256,uint256,uint256,uint256)',
      [A.underlying],
    ),
  ])
  if (!same(provider, A.aaveProvider)) return null
  const [rawKink, rawBase, rawSlope1, rawSlope2] = tuple(data, 4)
  const kink = unsigned(rawKink),
    base = unsigned(rawBase),
    slope1 = unsigned(rawSlope1),
    slope2 = unsigned(rawSlope2)
  // Aave governance may update parameters in the reviewed implementation. Read current
  // values each block; enforce that implementation's BPS granularity and bounds.
  if (
    [kink, base, slope1, slope2].some((v) => v % 10n ** 23n !== 0n) ||
    kink < R / 100n ||
    kink > (R * 99n) / 100n ||
    slope2 < slope1 ||
    base + slope1 + slope2 > 1000n * R
  )
    return null
  return {
    kind: 'aave-v3-two-slope',
    ...p,
    verified: true,
    clock: { kind: 'annual', scale: R },
    baseBorrowRate: base,
    slopeBelowKink: slope1,
    slopeAboveKink: slope2,
    kinkWad: (kink * U) / R,
  }
}

async function feed(
  ctx: YieldResolverContext,
  p: typeof YIELD_MAINNET_REVIEW.bnbFeed | typeof YIELD_MAINNET_REVIEW.usdtFeed,
) {
  await Promise.all([
    pin(ctx, p),
    pin(ctx, { address: p.aggregator, runtimeHash: p.aggregatorHash }),
  ])
  const [aggregator, description, decimals, data] = await Promise.all([
    ctx.read(p.address, 'function aggregator() view returns(address)'),
    ctx.read(p.address, 'function description() view returns(string)'),
    ctx.read(p.address, 'function decimals() view returns(uint8)'),
    ctx.read(
      p.address,
      'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
    ),
  ])
  if (
    !same(aggregator, p.aggregator) ||
    description !== p.description ||
    (decimals !== 8 && decimals !== 8n)
  )
    throw new Error('Unreviewed feed')
  const [rawRound, rawAnswer, rawStarted, rawUpdated, rawAnswered] = tuple(data, 5)
  const round = unsigned(rawRound),
    answer = int(rawAnswer),
    started = unsigned(rawStarted),
    updated = unsigned(rawUpdated),
    answered = unsigned(rawAnswered)
  const now = BigInt(ctx.block.timestamp)
  if (
    round === 0n ||
    answer <= 0n ||
    started === 0n ||
    updated < started ||
    updated > now ||
    answered < round ||
    now - updated > BigInt(p.maxAgeSeconds)
  )
    throw new Error('Invalid feed round')
  return { answer, updatedAt: Number(updated) }
}

/** Read-only concrete resolvers. Unknown identities, model changes and stale feeds produce
 * null, not a guessed rate or dollar peg. The planner turns null into an explicit no-op. */
export const canonicalYieldResolvers: YieldSnapshotResolvers = {
  model: async (id, address, ctx) => {
    try {
      if (ctx.block.chainId !== 56 || !ctx.block.canonical || !ctx.block.finalized) return null
      if (id === 'venus' && same(address, YIELD_MAINNET_REVIEW.venusWrapper.address))
        return await venus(ctx)
      if (id === 'aave' && same(address, YIELD_MAINNET_REVIEW.aaveModel.address))
        return await aave(ctx)
      return null
    } catch {
      return null
    }
  },
  nativePrice: async (ctx): Promise<YieldSnapshot['nativePrice']> => {
    try {
      if (ctx.block.chainId !== 56 || !ctx.block.canonical || !ctx.block.finalized) return null
      const [bnb, usdt] = await Promise.all([
        feed(ctx, YIELD_MAINNET_REVIEW.bnbFeed),
        feed(ctx, YIELD_MAINNET_REVIEW.usdtFeed),
      ])
      return {
        blockNumber: ctx.block.number,
        blockHash: ctx.block.hash,
        usdtPerBnbRay: ceilDiv(bnb.answer * R, usdt.answer),
        updatedAt: Math.min(bnb.updatedAt, usdt.updatedAt),
        verified: true,
      }
    } catch {
      return null
    }
  },
}

export const CANONICAL_YIELD_MODEL_PINS = [
  YIELD_MAINNET_REVIEW.venusWrapper,
  YIELD_MAINNET_REVIEW.aaveModel,
] as const
