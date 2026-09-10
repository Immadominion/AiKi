import { describe, expect, it, vi } from 'vitest'
import {
  CANONICAL_YIELD_MODEL_PINS,
  canonicalYieldResolvers,
  YIELD_MAINNET_REVIEW as P,
} from './mainnet-resolvers.js'
import {
  ceilDiv,
  normalizeYieldRate,
  YIELD_RAY as R,
  supplyRateAfter,
  YIELD_WAD as U,
  YIELD_YEAR,
} from './rates.js'
import { YIELD_READ_ADDRESSES as A, type YieldResolverContext } from './snapshot.js'
import type {
  YieldAddress,
  YieldPlannerPolicy,
  YieldRateModel,
  YieldVenueSnapshot,
} from './types.js'

const BLOCK = 121_004_566n
const NOW = 1_789_013_755
const HASH = '0x6acee84239c85de59079b7294a01251752e0c75a4a46f00bc1cdfc382366966d' as const
const OTHER = '0x9999999999999999999999999999999999999999'

function fixture() {
  const values = new Map<string, unknown>()
  const key = (target: string, method: string) => `${target.toLowerCase()}:${method}`
  const set = (target: string, method: string, value: unknown) =>
    values.set(key(target, method), value)
  set(P.venusWrapper.address, 'currentDataSource', P.venusModel.address)
  set(P.venusWrapper.address, 'DATA_SOURCE_1', P.venusPreviousModel)
  set(P.venusWrapper.address, 'DATA_SOURCE_2', P.venusModel.address)
  set(P.venusWrapper.address, 'CHECKPOINT_TIMESTAMP', BigInt(P.checkpointTimestamp))
  const params = {
    BASE_RATE_PER_BLOCK: 0n,
    MULTIPLIER_PER_BLOCK: 934306370n,
    KINK_1: 840000000000000000n,
    MULTIPLIER_2_PER_BLOCK: 3567351597n,
    BASE_RATE_2_PER_BLOCK: 0n,
    KINK_2: 920000000000000000n,
    JUMP_MULTIPLIER_PER_BLOCK: 57969463470n,
    RATE_1: 784817350n,
    RATE_2: 285388127n,
    BLOCKS_PER_YEAR: 70080000n,
  }
  for (const [name, value] of Object.entries(params)) set(P.venusModel.address, name, value)
  set(P.aaveModel.address, 'ADDRESSES_PROVIDER', A.aaveProvider)
  set(P.aaveModel.address, 'getInterestRateData', [(R * 9n) / 10n, 0n, (44n * R) / 1000n, R / 10n])
  for (const p of [P.bnbFeed, P.usdtFeed]) {
    set(p.address, 'aggregator', p.aggregator)
    set(p.address, 'description', p.description)
    set(p.address, 'decimals', 8)
    set(p.address, 'latestRoundData', [
      100n,
      p.description === 'BNB / USD' ? 72283500000n : 99962000n,
      BigInt(NOW - 10),
      BigInt(NOW - 3),
      100n,
    ])
  }
  const pins = new Map<string, `0x${string}`>(
    [
      P.venusWrapper,
      P.venusModel,
      P.aaveModel,
      P.bnbFeed,
      P.usdtFeed,
      { address: P.bnbFeed.aggregator, runtimeHash: P.bnbFeed.aggregatorHash },
      { address: P.usdtFeed.aggregator, runtimeHash: P.usdtFeed.aggregatorHash },
    ].map((p) => [p.address, p.runtimeHash]),
  )
  const read = vi.fn(
    async (target: YieldAddress, signature: string, _args: readonly unknown[] = []) => {
      const method = /^function\s+(\w+)\(/.exec(signature)?.[1]
      const value = values.get(key(target, method ?? ''))
      if (value === undefined) throw new Error('Unknown fixture call')
      return value
    },
  )
  const codeHash = vi.fn(async (target: YieldAddress) => {
    const hash = pins.get(target.toLowerCase())
    if (!hash) throw new Error('Unknown fixture code')
    return hash
  })
  const blockAt = vi.fn(async (number: bigint) => ({ number, timestamp: NOW - 1843, hash: HASH }))
  const ctx: YieldResolverContext = {
    block: {
      chainId: 56,
      number: BLOCK,
      hash: HASH,
      timestamp: NOW,
      canonical: true,
      finalized: true,
    },
    read,
    codeHash,
    blockAt,
  }
  return { ctx, set, pins, read, codeHash, blockAt }
}

async function resolve(
  id: 'venus' | 'aave',
  f: ReturnType<typeof fixture>,
  address?: YieldAddress,
) {
  return canonicalYieldResolvers.model?.(
    id,
    address ?? (id === 'venus' ? P.venusWrapper.address : P.aaveModel.address),
    f.ctx,
  )
}
const price = (f: ReturnType<typeof fixture>) => canonicalYieldResolvers.nativePrice?.(f.ctx)
const policy = {
  reviewedModels: [...CANONICAL_YIELD_MODEL_PINS],
  minClockSampleSeconds: 300,
} satisfies Pick<YieldPlannerPolicy, 'reviewedModels' | 'minClockSampleSeconds'>
function venue(
  id: 'venus' | 'aave',
  model: YieldRateModel,
  cash: bigint,
  debt: bigint,
): YieldVenueSnapshot {
  return {
    id,
    model,
    blockNumber: BLOCK,
    blockHash: HASH,
    identityVerified: true,
    underlying: A.underlying,
    market: A[id],
    receipt: id === 'venus' ? A.venus : A.aaveReceipt,
    decimals: 18,
    listed: true,
    active: true,
    supplyPaused: false,
    withdrawPaused: false,
    frozen: false,
    legacy: false,
    cash,
    virtualCash: cash,
    debt,
    reserves: 0n,
    unbacked: 0n,
    stableDebt: 0n,
    reserveFactorWad: U / 10n,
    totalSupplied: cash + debt,
    accruedTreasuryAssets: 0n,
    supplyCap: 1_000_000n * U,
    withdrawalFeeWad: 0n,
    receiptRate: id === 'venus' ? 2n * 10n ** 26n : R,
    actualReceiptBalance: 0n,
    observedSupplyRate: 0n,
  }
}

describe('canonical BSC yield resolvers', () => {
  it('resolves the exact checkpoint-selected Venus two-kink model and measures the real block clock', async () => {
    const f = fixture()
    const model = await resolve('venus', f)
    expect(model?.kind).toBe('venus-two-kinks')
    if (model?.kind !== 'venus-two-kinks') throw new Error('Expected reviewed model')
    expect(model.implementationHash).toBe(P.venusModel.runtimeHash)
    expect(model.clock).toEqual({
      kind: 'per-block',
      scale: U,
      verifiedOnchain: true,
      sampleStartBlock: BLOCK - 4096n,
      sampleStartTimestamp: NOW - 1843,
    })
    const annual = normalizeYieldRate(1n, venue('venus', model, U, U), f.ctx.block, policy)
    expect(annual).toBe((R * YIELD_YEAR * 4096n) / (U * 1843n))
    expect(annual).not.toBe((R * model.blocksPerYear) / U)
    expect(f.blockAt).toHaveBeenCalledWith(BLOCK - 4096n)
  })

  it('reads current Aave per-reserve annual ray parameters instead of hardcoding the rate', async () => {
    const f = fixture()
    f.set(P.aaveModel.address, 'getInterestRateData', [(R * 8n) / 10n, R / 100n, R / 20n, R / 5n])
    const model = await resolve('aave', f)
    expect(model).toMatchObject({
      kind: 'aave-v3-two-slope',
      clock: { kind: 'annual', scale: R },
      baseBorrowRate: R / 100n,
      slopeBelowKink: R / 20n,
      slopeAboveKink: R / 5n,
      kinkWad: (U * 8n) / 10n,
    })
    expect(f.read).toHaveBeenCalledWith(
      P.aaveModel.address,
      'function getInterestRateData(address) view returns(uint256,uint256,uint256,uint256)',
      [A.underlying],
    )
  })

  it('does not inspect or guess unknown model addresses', async () => {
    const f = fixture()
    expect(await resolve('venus', f, OTHER)).toBeNull()
    expect(await resolve('aave', f, OTHER)).toBeNull()
    expect(f.read).not.toHaveBeenCalled()
  })

  it.each([P.venusWrapper.address, P.venusModel.address, P.aaveModel.address])(
    'rejects a changed runtime at %s',
    async (target) => {
      const f = fixture()
      f.pins.set(target, HASH)
      expect(await resolve(target === P.aaveModel.address ? 'aave' : 'venus', f)).toBeNull()
    },
  )

  it.each(['currentDataSource', 'DATA_SOURCE_1', 'DATA_SOURCE_2', 'CHECKPOINT_TIMESTAMP'])(
    'rejects an unsupported Venus wrapper %s',
    async (field) => {
      const f = fixture()
      f.set(
        P.venusWrapper.address,
        field,
        field === 'CHECKPOINT_TIMESTAMP' ? BigInt(NOW + 1) : OTHER,
      )
      expect(await resolve('venus', f)).toBeNull()
    },
  )

  it('rejects changed signed immutable parameters, unusable clock samples and pre-checkpoint samples', async () => {
    const f = fixture()
    f.set(P.venusModel.address, 'MULTIPLIER_PER_BLOCK', -1n)
    expect(await resolve('venus', f)).toBeNull()
    f.set(P.venusModel.address, 'MULTIPLIER_PER_BLOCK', 934306370n)
    f.blockAt.mockResolvedValueOnce({ number: BLOCK - 4096n, timestamp: NOW - 100, hash: HASH })
    expect(await resolve('venus', f)).toBeNull()
    f.blockAt.mockResolvedValueOnce({
      number: BLOCK - 4096n,
      timestamp: P.checkpointTimestamp - 1,
      hash: HASH,
    })
    expect(await resolve('venus', f)).toBeNull()
  })

  it.each([
    [R, 0n, R / 10n, R],
    [R / 2n, 0n, R, R / 10n],
    [R / 2n, 1n, R / 10n, R],
    [R / 2n, 1000n * R, R, R],
  ])('rejects unsupported Aave parameter tuple %s', async (kink, base, slope1, slope2) => {
    const f = fixture()
    f.set(P.aaveModel.address, 'getInterestRateData', [kink, base, slope1, slope2])
    expect(await resolve('aave', f)).toBeNull()
  })

  it('prices gas using BOTH independently fresh USD feeds, including a USDT depeg', async () => {
    const f = fixture()
    f.set(P.usdtFeed.address, 'latestRoundData', [
      100n,
      95_000_000n,
      BigInt(NOW - 600),
      BigInt(NOW - 590),
      100n,
    ])
    const result = await price(f)
    expect(result?.usdtPerBnbRay).toBe(ceilDiv(72283500000n * R, 95_000_000n))
    expect(result?.usdtPerBnbRay).toBeGreaterThan((72283500000n * R) / 100_000_000n)
    expect(result?.updatedAt).toBe(NOW - 590)
    expect(result?.blockHash).toBe(HASH)
  })

  it.each(['aggregator', 'description', 'decimals'])('rejects changed feed %s', async (field) => {
    const f = fixture()
    f.set(P.bnbFeed.address, field, field === 'decimals' ? 18 : OTHER)
    expect(await price(f)).toBeNull()
  })

  it.each([P.bnbFeed.address, P.bnbFeed.aggregator, P.usdtFeed.address, P.usdtFeed.aggregator])(
    'rejects changed feed code at %s',
    async (target) => {
      const f = fixture()
      f.pins.set(target, HASH)
      expect(await price(f)).toBeNull()
    },
  )

  it('rejects zero/negative/incomplete/future/stale Chainlink rounds and RPC failures', async () => {
    for (const round of [
      [0n, 1n, 1n, BigInt(NOW), 0n],
      [100n, -1n, BigInt(NOW - 1), BigInt(NOW), 100n],
      [100n, 1n, BigInt(NOW), BigInt(NOW), 99n],
      [100n, 1n, BigInt(NOW), BigInt(NOW + 1), 100n],
      [100n, 1n, 0n, BigInt(NOW), 100n],
      [100n, 1n, BigInt(NOW - 100), BigInt(NOW - 91), 100n],
    ]) {
      const f = fixture()
      f.set(P.bnbFeed.address, 'latestRoundData', round)
      expect(await price(f)).toBeNull()
    }
    const f = fixture()
    f.set(P.usdtFeed.address, 'latestRoundData', [
      100n,
      1n,
      BigInt(NOW - 1000),
      BigInt(NOW - 931),
      100n,
    ])
    expect(await price(f)).toBeNull()
    f.read.mockRejectedValue(new Error('private upstream detail'))
    expect(await resolve('venus', f)).toBeNull()
    expect(await price(f)).toBeNull()
  })
})

describe('canonical rate arithmetic', () => {
  // Captured by read-only calls to the reviewed deployments at block121004566; no test RPC.
  const vectors = [
    [8000n, 2000n, 33635029n, 1760000000000000000000000n],
    [1600n, 8400n, 593321916n, 31046400000000000000000000n],
    [1200n, 8800n, 734589038n, 34073600000000000000000000n],
    [800n, 9200n, 886130134n, 52992000000000000000000000n],
    [100n, 9900n, 4569108515n, 119394000000000000000000000n],
    [3333n, 7777n, 412029109n, 21560000000000000000000000n],
  ]
  it.each(vectors)(
    'matches actual Venus/Aave supply arithmetic at cash=%s debt=%s',
    async (cash, debt, expectedVenus, expectedAave) => {
      const f = fixture()
      const vm = await resolve('venus', f),
        am = await resolve('aave', f)
      if (!vm || !am) throw new Error('Expected reviewed models')
      const v = venue('venus', vm, cash * U, debt * U)
      const a = venue('aave', am, cash * U, debt * U)
      expect(supplyRateAfter(v, 0n, f.ctx.block, policy)).toBe(
        normalizeYieldRate(expectedVenus, v, f.ctx.block, policy),
      )
      expect(supplyRateAfter(a, 0n, f.ctx.block, policy)).toBe(expectedAave)
    },
  )
})
