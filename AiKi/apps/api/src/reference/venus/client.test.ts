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
