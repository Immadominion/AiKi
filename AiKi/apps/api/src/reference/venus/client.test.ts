import { describe, expect, it } from 'vitest'
import { assessVenusSnapshot } from './client.js'
import { type VenusAccountSnapshot, WAD } from './types.js'

const account = '0x1111111111111111111111111111111111111111' as const
function snapshot(overrides: Partial<VenusAccountSnapshot> = {}): VenusAccountSnapshot {
  return {
    account,
    observedAt: '2026-08-22T00:00:00.000Z',
    controllerLiquidity: 60n * WAD,
    controllerShortfall: 0n,
    markets: [
      {
        vToken: '0x2222222222222222222222222222222222222222',
        collateralFactor: (8n * WAD) / 10n,
        liquidationThreshold: (8n * WAD) / 10n,
        vTokenBalance: 100n * WAD,
        borrowBalance: 100n * WAD,
        exchangeRate: 2n * WAD,
        underlyingPrice: WAD,
      },
    ],
    ...overrides,
  }
}

describe('assessVenusSnapshot', () => {
  it('derives and cross-checks a safe health factor without using floats', () => {
    const assessment = assessVenusSnapshot(snapshot())
    expect(assessment.status).toBe('SAFE')
    expect(assessment.healthFactor).toBe('1.6')
    expect(assessment.consistency.verified).toBe(true)
    expect(assessment.adjustedCollateral.amount).toBe((160n * WAD).toString())
  })

  it('marks a position at risk below the caller threshold', () => {
    const assessment = assessVenusSnapshot(
      snapshot({
        controllerLiquidity: 20n * WAD,
        markets: [
          {
            vToken: '0x2222222222222222222222222222222222222222',
            collateralFactor: (8n * WAD) / 10n,
            liquidationThreshold: (8n * WAD) / 10n,
            vTokenBalance: 100n * WAD,
            borrowBalance: 140n * WAD,
            exchangeRate: 2n * WAD,
            underlyingPrice: WAD,
          },
        ],
      }),
      '1.25',
    )
    expect(assessment.status).toBe('AT_RISK')
    expect(assessment.healthFactor).toBe('1.142857142857142857')
  })

  it('treats controller shortfall as liquidatable', () => {
    const assessment = assessVenusSnapshot(
      snapshot({
        controllerLiquidity: 0n,
        controllerShortfall: 40n * WAD,
        markets: [
          {
            vToken: '0x2222222222222222222222222222222222222222',
            collateralFactor: (8n * WAD) / 10n,
            liquidationThreshold: (8n * WAD) / 10n,
            vTokenBalance: 100n * WAD,
            borrowBalance: 200n * WAD,
            exchangeRate: 2n * WAD,
            underlyingPrice: WAD,
          },
        ],
      }),
    )
    expect(assessment.status).toBe('LIQUIDATABLE')
  })

  it('refuses to produce an automation-grade result when the derivation disagrees with Venus', () => {
    const assessment = assessVenusSnapshot(snapshot({ controllerLiquidity: 0n }))
    expect(assessment.status).toBe('INCONSISTENT')
    expect(assessment.consistency.verified).toBe(false)
  })
})

it('reads a position whose liquidation threshold differs from its collateral factor', () => {
  /*
   * The exact shape observed on BSC testnet vUSDT: Venus lends at 0.75 and
   * liquidates at 0.80. Deriving the health factor from the collateral factor
   * puts adjusted collateral at 375 while the Comptroller — which uses the
   * threshold — reports 400, the consistency check fires, and the guardian
   * refuses to act on a position it has read perfectly correctly.
   *
   * Every number here is from the live chain: 1000 USDT supplied at $0.50, 740
   * USDT borrowed.
   */
  const price = 500_000_000_000_000_000_000_000_000_000n // 1e30 scale, 6-decimal token
  const assessment = assessVenusSnapshot(
    {
      account: `0x${'11'.repeat(20)}`,
      observedAt: '2026-08-30T00:00:00.000Z',
      // 0.80 x $500 = $400, exactly what the Comptroller reports.
      controllerLiquidity: 30n * WAD,
      controllerShortfall: 0n,
      markets: [
        {
          vToken: `0x${'22'.repeat(20)}`,
          collateralFactor: (75n * WAD) / 100n,
          liquidationThreshold: (80n * WAD) / 100n,
          vTokenBalance: 4_980_663_521_914n,
          borrowBalance: 740_000_000n,
          exchangeRate: 200_776_461_931_237n,
          underlyingPrice: price,
        },
      ],
    },
    '1.25',
  )
  expect(assessment.consistency.verified).toBe(true)
  expect(assessment.status).toBe('AT_RISK')
  // 400/370, not 375/370.
  expect(assessment.healthFactor?.slice(0, 6)).toBe('1.0810')
})
