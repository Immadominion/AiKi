import { expect, it } from 'vitest'
import { InMemoryEvidenceStore } from '../../evidence/store.js'
import { assessVenusSnapshot } from './client.js'
import { persistVenusAssessment } from './evidence-sink.js'
import { type VenusAccountSnapshot, WAD } from './types.js'

it('persists a category assessment and each entered market as immutable evidence', async () => {
  const snapshot: VenusAccountSnapshot = {
    account: '0x1111111111111111111111111111111111111111',
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
  }
  const store = new InMemoryEvidenceStore()
  const inserted = await persistVenusAssessment(store, {
    agentId: '123',
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    chainId: 56,
    assessment: assessVenusSnapshot(snapshot),
  })
  expect(inserted).toBe(2)
  expect(store.observations.map((observation) => observation.predicate)).toEqual([
    'venus.health_factor_assessment',
    'venus.position_snapshot',
  ])
})
