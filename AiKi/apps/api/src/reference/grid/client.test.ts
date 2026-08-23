import { expect, it } from 'vitest'
import { assessGrid } from './client.js'
const policy = { pool: '0x1111111111111111111111111111111111111111' as const, tickLower: 100, tickUpper: 200, spacing: 20 }
it('only shifts a grid after price leaves the declared range', () => {
  expect(assessGrid(policy, 150, 1n)).toMatchObject({ state: 'IN_GRID', recommendation: 'WAIT', activeBand: { lower: 140, upper: 160 } })
  expect(assessGrid(policy, 99, 1n)).toMatchObject({ state: 'BELOW_GRID', recommendation: 'SHIFT_GRID_DOWN' })
  expect(assessGrid(policy, 200, 1n)).toMatchObject({ state: 'ABOVE_GRID', recommendation: 'SHIFT_GRID_UP' })
})
