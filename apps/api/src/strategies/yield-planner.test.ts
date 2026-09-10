import { describe, expect, it } from 'vitest'
import {
  fullGasCost,
  normalizeYieldRate,
  supplyRateAfter,
  YIELD_RAY,
  YIELD_WAD,
  YIELD_YEAR,
} from './yield/rates.js'
import type {
  YieldCandidate,
  YieldExecutionQuote,
  YieldPlannerPolicy,
  YieldPlannerState,
  YieldSnapshot,
  YieldVenueSnapshot,
} from './yield/types.js'
import { decideYield, YIELD_CANONICAL } from './yield-planner.js'

const address = (digit: string) => `0x${digit.repeat(40)}` as const
const hash = (digit: string) => `0x${digit.repeat(64)}` as const
const U = YIELD_WAD
const R = YIELD_RAY
const NOW = 1_000_000

function fixture(): { snapshot: YieldSnapshot; policy: YieldPlannerPolicy } {
  const limits = {
    maxPrincipal: 1_000n * U,
    maxMove: 500n * U,
    maxTurnover: 2_000n * U,
    minIdle: 100n * U,
    maxVenusExposure: 800n * U,
    maxAaveExposure: 800n * U,
    maxLossPerMove: U,
    maxCumulativeLoss: 2n * U,
    maxLossBps: 100,
  }
  const base: YieldVenueSnapshot = {
    id: 'venus',
    blockNumber: 10_000n,
    blockHash: hash('a'),
    identityVerified: true,
    underlying: YIELD_CANONICAL.underlying,
    market: YIELD_CANONICAL.venus,
    receipt: YIELD_CANONICAL.venus,
    decimals: 18,
    listed: true,
    active: true,
    supplyPaused: false,
    withdrawPaused: false,
    frozen: false,
    legacy: false,
    cash: 100_000n * U,
    virtualCash: 100_000n * U,
    debt: 100_000n * U,
    reserves: 0n,
    unbacked: 0n,
    stableDebt: 0n,
    reserveFactorWad: U / 10n,
    totalSupplied: 200_000n * U,
    accruedTreasuryAssets: 0n,
    supplyCap: 1_000_000n * U,
    withdrawalFeeWad: 0n,
    receiptRate: 2n * 10n ** 26n,
    actualReceiptBalance: 0n,
    observedSupplyRate: 562_500_000n,
    model: {
      kind: 'reviewed-two-slope',
      address: address('1'),
      runtimeHash: hash('1'),
      verified: true,
      clock: { kind: 'per-second', scale: U, verifiedOnchain: true },
      baseBorrowRate: 0n,
      slopeBelowKink: 2_000_000_000n,
      slopeAboveKink: 20_000_000_000n,
      kinkWad: (8n * U) / 10n,
    },
  }
  const aave: YieldVenueSnapshot = {
    ...structuredClone(base),
    id: 'aave',
    market: YIELD_CANONICAL.aave,
    receipt: YIELD_CANONICAL.aaveReceipt,
    receiptRate: R,
    observedSupplyRate: (3375n * R) / 100_000n,
    model: {
      kind: 'reviewed-two-slope',
      address: address('2'),
      runtimeHash: hash('2'),
      verified: true,
      clock: { kind: 'annual', scale: R },
      baseBorrowRate: 0n,
      slopeBelowKink: (12n * R) / 100n,
      slopeAboveKink: R,
      kinkWad: (8n * U) / 10n,
    },
  }
  const snapshot: YieldSnapshot = {
    block: {
      chainId: 56,
      number: 10_000n,
      hash: hash('a'),
      timestamp: NOW,
      finalized: true,
      canonical: true,
    },
    vault: address('3'),
    controller: address('4'),
    policyHash: hash('5'),
    identityVerified: true,
    expiresAt: NOW + 90 * 86_400,
    minInterval: 60,
    maxDeadlineDelay: 300,
    limits,
    nonce: 2n,
    lastExecutionAt: 0,
    paused: false,
    fundedPrincipal: 1_000n * U,
    turnover: 0n,
    cumulativeLoss: 0n,
    managedIdle: 1_000n * U,
    actualIdle: 1_000n * U,
    managedVenusShares: 0n,
    managedAaveScaled: 0n,
    venues: { venus: base, aave },
    nativePrice: {
      blockNumber: 10_000n,
      blockHash: hash('a'),
      usdtPerBnbRay: 600n * R,
      updatedAt: NOW,
      verified: true,
    },
    executionQuotes: [],
  }
  const policy: YieldPlannerPolicy = {
    vault: snapshot.vault,
    controller: snapshot.controller,
    policyHash: snapshot.policyHash,
    limits: { ...limits },
    horizonSeconds: 30 * 86_400,
    maxSnapshotAgeSeconds: 30,
    maxPriceAgeSeconds: 60,
    minClockSampleSeconds: 300,
    maxObservationGapSeconds: 60,
    requiredObservations: 1,
    minObservationSeconds: 10,
    minMove: U,
    minIncrementalYield: U / 100n,
    minNetGain: U / 100n,
    maxGasCost: U,
    gasBufferBps: 2_000,
    capacityBuffer: U,
    liquidityBuffer: U,
    minIdleBps: 1_000,
    rateToleranceRay: 0n,
    reviewedModels: [
      { address: address('1'), runtimeHash: hash('1') },
      { address: address('2'), runtimeHash: hash('2') },
    ],
  }
  return { snapshot, policy }
}

function quote(snapshot: YieldSnapshot, candidate: YieldCandidate): YieldExecutionQuote {
  return {
    vault: snapshot.vault,
    policyHash: snapshot.policyHash,
    blockNumber: snapshot.block.number,
    blockHash: snapshot.block.hash,
    nonce: snapshot.nonce,
    source: candidate.source,
    destination: candidate.destination,
    assets: candidate.assets,
    minReceived: candidate.expectedMoved,
    deadline: snapshot.block.timestamp + 120,
    path: 'manager-delegation',
    simulated: true,
    gasUnits: 200_000n,
    gasPriceWei: 100_000_000n,
    unwindGasUnits: 150_000n,
  }
}

function priced(
  snapshot: YieldSnapshot,
  policy: YieldPlannerPolicy,
  now = snapshot.block.timestamp,
): YieldSnapshot {
  const result = decideYield({ ...snapshot, executionQuotes: [] }, policy, {}, now)
  if (!result.act && result.candidates)
    snapshot.executionQuotes = result.candidates.map((c) => quote(snapshot, c))
  return snapshot
}

function advance(s: YieldSnapshot, seconds = 10, digit = 'b'): YieldSnapshot {
  const next = structuredClone(s)
  next.block = {
    ...next.block,
    number: next.block.number + 20n,
    timestamp: next.block.timestamp + seconds,
    hash: hash(digit),
  }
  for (const id of ['venus', 'aave'] as const)
    Object.assign(next.venues[id], { blockNumber: next.block.number, blockHash: next.block.hash })
  if (next.nativePrice)
    Object.assign(next.nativePrice, {
      blockNumber: next.block.number,
      blockHash: next.block.hash,
      updatedAt: next.block.timestamp,
    })
  next.executionQuotes = []
  return next
}

function holdVenus(s: YieldSnapshot, assets: bigint) {
  s.managedIdle = s.actualIdle = 1_000n * U - assets
  s.managedVenusShares = (assets * U) / s.venues.venus.receiptRate
  s.venues.venus.actualReceiptBalance = s.managedVenusShares
}

describe('yield rates and exact units', () => {
  it('normalizes annual, per-second and measured per-block clocks without a fixed BSC year', () => {
    const { snapshot: s, policy: p } = fixture()
    expect(normalizeYieldRate(1n, s.venues.venus, s.block, p)).toBe((R * YIELD_YEAR) / U)
    const model = s.venues.venus.model
    expect(model).not.toBeNull()
    if (!model) return
    model.clock = {
      kind: 'per-block',
      scale: U,
      verifiedOnchain: true,
      sampleStartBlock: s.block.number - 1_000n,
      sampleStartTimestamp: NOW - 500,
    }
    expect(normalizeYieldRate(1n, s.venues.venus, s.block, p)).toBe((2n * R * YIELD_YEAR) / U)
    model.clock.sampleStartTimestamp = NOW - 100
    expect(normalizeYieldRate(1n, s.venues.venus, s.block, p)).toBeNull()
    expect(normalizeYieldRate(R / 10n, s.venues.aave, s.block, p)).toBe(R / 10n)
  })

  it('reprices utilization after the full proposed deposit and withdrawal', () => {
    const { snapshot: s, policy: p } = fixture()
    const current = supplyRateAfter(s.venues.aave, 0n, s.block, p)
    const afterDeposit = supplyRateAfter(s.venues.aave, 50_000n * U, s.block, p)
    const afterWithdrawal = supplyRateAfter(s.venues.aave, -50_000n * U, s.block, p)
    expect(current).toBe((3375n * R) / 100_000n)
    expect(afterDeposit).not.toBeNull()
    expect(afterWithdrawal).not.toBeNull()
    expect((afterDeposit ?? 0n) < (current ?? 0n)).toBe(true)
    expect((afterWithdrawal ?? 0n) > (current ?? 0n)).toBe(true)
    expect(fullGasCost(100_000n, 1_000_000_000n, 600n * R, 2_000)).toBe(72n * 10n ** 15n)
  })
})

describe('yield planner', () => {
  it('cannot justify execution with income beyond the immutable authority expiry', () => {
    const { snapshot: s, policy: p } = fixture()
    s.expiresAt = NOW + 3_600
    const decision = decideYield(priced(s, p), p, {}, NOW)
    expect(decision.code).toBe('NO_NET_BENEFIT')
    p.minIncrementalYield = p.minNetGain = 0n
    p.gasBufferBps = 0
    const unquoted = decideYield(s, p, {}, NOW)
    expect(unquoted.act).toBe(false)
    if (!unquoted.act && unquoted.candidates) {
      expect(unquoted.candidates.every((c) => c.horizonSeconds === 3_600)).toBe(true)
      expect(unquoted.candidates.every((c) => c.incrementalYield < U / 100n)).toBe(true)
    } else throw new Error('Expected bounded candidate quotes')
  })

  it('requires full manager quotes before producing an exact bounded allocation', () => {
    const { snapshot: s, policy: p } = fixture()
    const first = decideYield(s, p, {}, NOW)
    expect(first.code).toBe('QUOTE_REQUIRED')
    const decision = decideYield(priced(s, p), p, {}, NOW)
    expect(decision.act).toBe(true)
    if (!decision.act) return
    expect(decision.plan.source).toBe('idle')
    expect(decision.plan.destination).toBe('aave')
    expect(decision.plan.assets).toBe(500n * U)
    expect(decision.plan.expectedNonce).toBe(2n)
    expect(decision.plan.quoteBlockHash).toBe(s.block.hash)
    expect(decision.plan.minReceived).toBe(decision.plan.expectedMoved)
    expect(decision.plan.deadline).toBe(NOW + 120)
    expect(decision.plan.netGain > p.minNetGain).toBe(true)
  })

  it('actually reallocates from a held lower-yield venue', () => {
    const { snapshot: s, policy: p } = fixture()
    holdVenus(s, 900n * U)
    const d = decideYield(priced(s, p), p, {}, NOW)
    expect(d.act).toBe(true)
    if (d.act)
      expect([d.plan.source, d.plan.destination, d.plan.assets]).toEqual([
        'venus',
        'aave',
        500n * U,
      ])
  })

  it('can choose a smaller reallocation when the full move depresses destination yield', () => {
    const { snapshot: s, policy: p } = fixture()
    holdVenus(s, 500n * U)
    s.limits.minIdle = p.limits.minIdle = 500n * U
    s.venues.venus.cash = s.venues.venus.virtualCash = 500n * U
    s.venues.venus.debt = 500n * U
    s.venues.venus.totalSupplied = 1_000n * U
    s.venues.aave.cash = s.venues.aave.virtualCash = 50n * U
    s.venues.aave.debt = 500n * U
    s.venues.aave.totalSupplied = 550n * U
    s.venues.aave.observedSupplyRate = supplyRateAfter(s.venues.aave, 0n, s.block, p) ?? 0n
    const d = decideYield(priced(s, p), p, {}, NOW)
    expect(d.act).toBe(true)
    if (d.act) {
      expect(d.plan.source).toBe('venus')
      expect(d.plan.destination).toBe('aave')
      expect(d.plan.assets < 400n * U).toBe(true)
      expect(d.plan.assets > 100n * U).toBe(true)
    }
  })

  it('conservatively no-ops for unknown models and unsupported debt configurations', () => {
    for (const change of [
      (s: YieldSnapshot) => {
        s.venues.venus.model = null
      },
      (s: YieldSnapshot) => {
        if (s.venues.venus.model) s.venues.venus.model.runtimeHash = hash('9')
      },
      (s: YieldSnapshot) => {
        s.venues.aave.unbacked = 1n
      },
      (s: YieldSnapshot) => {
        s.venues.aave.stableDebt = 1n
      },
    ]) {
      const { snapshot: s, policy: p } = fixture()
      change(s)
      expect(decideYield(s, p, {}, NOW).code).toBe('RATE_MODEL_UNSUPPORTED')
    }
  })

  it('refuses a plausible but nonmatching model rate', () => {
    const { snapshot: s, policy: p } = fixture()
    s.venues.aave.observedSupplyRate += 1n
    expect(decideYield(s, p, {}, NOW).code).toBe('RATE_MISMATCH')
  })

  it.each(['legacy', 'supplyPaused', 'frozen'] as const)(
    'does not allocate into an Aave venue marked %s',
    (flag) => {
      const { snapshot: s, policy: p } = fixture()
      s.venues.aave[flag] = true
      const d = decideYield(priced(s, p), p, {}, NOW)
      expect(d.act).toBe(true)
      if (d.act) expect(d.plan.destination).toBe('venus')
    },
  )

  it('includes existing global supply, accrued treasury and buffer in the full destination cap', () => {
    const { snapshot: s, policy: p } = fixture()
    s.venues.aave.supplyCap = s.venues.aave.totalSupplied + 101n * U
    s.venues.aave.accruedTreasuryAssets = 50n * U
    const first = decideYield(s, p, {}, NOW)
    expect(first.act).toBe(false)
    if (!first.act)
      expect(first.candidates?.find((c) => c.destination === 'aave')?.assets).toBe(50n * U)
  })

  it('distinguishes Venus zero supply cap from explicitly unlimited Aave', () => {
    const { snapshot: s, policy: p } = fixture()
    s.venues.venus.supplyCap = 0n
    s.venues.aave.supplyCap = null
    const d = decideYield(priced(s, p), p, {}, NOW)
    expect(d.act).toBe(true)
    if (d.act) expect(d.plan.destination).toBe('aave')
    s.venues.venus.supplyCap = null
    expect(decideYield(s, p, {}, NOW).code).toBe('INCONSISTENT_SNAPSHOT')
  })

  it('limits withdrawal to available physical and virtual cash after the liquidity buffer', () => {
    const { snapshot: s, policy: p } = fixture()
    s.managedIdle = s.actualIdle = 0n
    s.managedAaveScaled = s.venues.aave.actualReceiptBalance = 1_000n * U
    s.venues.aave.virtualCash = 51n * U
    // Recompute a consistent observed rate for this utilization, using native annual units.
    s.venues.aave.observedSupplyRate = supplyRateAfter(s.venues.aave, 0n, s.block, p) ?? 0n
    const d = decideYield(s, p, {}, NOW)
    expect(d.code).toBe('QUOTE_REQUIRED')
    if (!d.act) expect(d.candidates?.[0]?.assets).toBe(50n * U)
  })

  it('restores idle with fees grossed up and does not strand rounding-sized deficits', () => {
    const { snapshot: s, policy: p } = fixture()
    holdVenus(s, 950n * U)
    s.venues.venus.withdrawalFeeWad = U / 1_000n
    const d = decideYield(priced(s, p), p, {}, NOW)
    expect(d.act).toBe(true)
    if (d.act) {
      expect(d.plan.reserveRestoration).toBe(true)
      expect(d.plan.destination).toBe('idle')
      expect(d.plan.expectedMoved >= 50n * U).toBe(true)
    }
    holdVenus(s, 900n * U + 200_000_000n)
    const dust = decideYield(priced(s, p), p, {}, NOW)
    expect(dust.act).toBe(true)
    if (dust.act) expect(dust.plan.assets).toBe(p.minMove)
  })

  it('does not reuse exhausted turnover for new investment, but can restore idle', () => {
    const { snapshot: s, policy: p } = fixture()
    s.turnover = s.limits.maxTurnover
    expect(decideYield(s, p, {}, NOW).code).toBe('NO_CAPACITY')
    holdVenus(s, 950n * U)
    expect(decideYield(priced(s, p), p, {}, NOW).act).toBe(true)
  })

  it('excludes donations and refuses actual inventory shortfalls', () => {
    const { snapshot: s, policy: p } = fixture()
    s.actualIdle = 1_000_000n * U
    s.venues.aave.actualReceiptBalance = 100_000n * U
    const d = decideYield(priced(s, p), p, {}, NOW)
    expect(d.act).toBe(true)
    if (d.act) expect(d.plan.assets).toBe(s.limits.maxMove)
    s.actualIdle = s.managedIdle - 1n
    expect(decideYield(s, p, {}, NOW).code).toBe('INCONSISTENT_SNAPSHOT')
  })

  it('cannot select a route lacking an exact fresh quote or with ambiguous duplicate quotes', () => {
    const { snapshot: s, policy: p } = fixture()
    priced(s, p)
    const q = s.executionQuotes[0]
    expect(q).toBeDefined()
    if (!q) return
    q.nonce += 1n
    expect(decideYield(s, p, {}, NOW).code).toBe('QUOTE_REQUIRED')
    priced(s, p)
    const fresh = s.executionQuotes[0]
    if (!fresh) throw new Error('fixture quote missing')
    s.executionQuotes.push({ ...fresh })
    expect(decideYield(s, p, {}, NOW).code).toBe('QUOTE_REQUIRED')
    priced(s, p)
    for (const quote of s.executionQuotes) quote.deadline = NOW + 301
    expect(decideYield(s, p, {}, NOW).code).toBe('QUOTE_REQUIRED')
  })

  it('includes unwind gas, fresh non-dollar-assumed USDT pricing and a safety margin', () => {
    const { snapshot: s, policy: p } = fixture()
    priced(s, p)
    for (const quote of s.executionQuotes) quote.unwindGasUnits = 100_000_000n
    expect(decideYield(s, p, {}, NOW).code).toBe('GAS_LIMIT')
    priced(s, p)
    s.nativePrice = null
    expect(decideYield(s, p, {}, NOW).code).toBe('PRICE_UNAVAILABLE')
    const { snapshot: other, policy: op } = fixture()
    op.minNetGain = 100n * U
    expect(decideYield(priced(other, op), op, {}, NOW).code).toBe('NO_NET_BENEFIT')
  })

  it('honors pause, expiry, cooldown and any unresolved nonce', () => {
    const { snapshot: s, policy: p } = fixture()
    expect(decideYield(s, p, { pendingNonce: 1n }, NOW).code).toBe('PENDING_EXECUTION')
    s.paused = true
    expect(decideYield(s, p, {}, NOW).code).toBe('PAUSED')
    s.paused = false
    s.expiresAt = NOW
    expect(decideYield(s, p, {}, NOW).code).toBe('EXPIRED')
    s.expiresAt = NOW + 1_000
    s.lastExecutionAt = NOW - 59
    expect(decideYield(s, p, {}, NOW).code).toBe('COOLDOWN')
  })

  it('does not count repeated or too-close polls as independent observations', () => {
    const { snapshot: s, policy: p } = fixture()
    p.requiredObservations = 3
    const one = decideYield(priced(s, p), p, {}, NOW)
    expect(one.code).toBe('HYSTERESIS')
    expect(one.nextState.lastObservation?.count).toBe(1)
    const repeated = decideYield(s, p, one.nextState, NOW)
    expect(repeated.nextState.lastObservation?.count).toBe(1)
    const tooSoon = advance(s, 3)
    const d = decideYield(priced(tooSoon, p), p, one.nextState, NOW + 3)
    expect(d.nextState).toEqual(one.nextState)
    const second = advance(s, 10)
    const two = decideYield(priced(second, p), p, d.nextState, NOW + 10)
    expect(two.nextState.lastObservation?.count).toBe(2)
    const third = advance(second, 10, 'c')
    expect(decideYield(priced(third, p), p, two.nextState, NOW + 20).act).toBe(true)
  })

  it('resets hysteresis after long gaps or owner nonce changes and rejects finalized rewinds', () => {
    const { snapshot: s, policy: p } = fixture()
    p.requiredObservations = 2
    const first = decideYield(priced(s, p), p, {}, NOW)
    const next = advance(s, 70)
    expect(decideYield(priced(next, p), p, first.nextState, NOW + 70).code).toBe('HYSTERESIS')
    const ownerChange = advance(s)
    ownerChange.nonce += 1n
    const changed = decideYield(priced(ownerChange, p), p, first.nextState, NOW + 10)
    expect(changed.nextState.lastObservation?.count).toBe(1)
    expect(decideYield(s, p, changed.nextState, NOW + 10).code).toBe('INCONSISTENT_SNAPSHOT')
  })

  it('rejects cross-network/asset/block/policy mixing, missing values and future snapshots', () => {
    for (const change of [
      (s: YieldSnapshot) => {
        s.venues.aave.underlying = address('9')
      },
      (s: YieldSnapshot) => {
        s.policyHash = hash('9')
      },
      (s: YieldSnapshot) => {
        s.venues.venus.blockNumber -= 1n
      },
      (s: YieldSnapshot) => {
        s.block.timestamp += 1
      },
      (s: YieldSnapshot) => {
        s.venues.aave.cash = -1n
      },
      (s: YieldSnapshot) => {
        s.limits.maxMove += 1n
      },
    ]) {
      const { snapshot: s, policy: p } = fixture()
      change(s)
      expect(decideYield(s, p, {}, NOW).act).toBe(false)
    }
    const { snapshot: s, policy: p } = fixture()
    expect(decideYield(s, p, {}, NOW + 31).code).toBe('STALE_SNAPSHOT')
    expect(decideYield({} as YieldSnapshot, p, {}, NOW).code).toBe('INVALID_INPUT')
    expect(decideYield(s, p, {} as YieldPlannerState, Number.NaN).act).toBe(false)
  })
})
