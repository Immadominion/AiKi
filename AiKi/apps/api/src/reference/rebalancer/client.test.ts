import { describe, expect, it } from 'vitest'
import { assessPancakePosition } from './client.js'
import type { PancakePositionSnapshot } from './types.js'

const base: PancakePositionSnapshot = { tokenId: '42', owner: '0x1111111111111111111111111111111111111111', token0: '0x2222222222222222222222222222222222222222', token1: '0x3333333333333333333333333333333333333333', fee: 500, tickLower: -100, tickUpper: 100, liquidity: '123', tokensOwed0: '0', tokensOwed1: '0', currentTick: 0, pool: '0x4444444444444444444444444444444444444444', observedAt: '2026-08-22T00:00:00.000Z' }
describe('assessPancakePosition', () => {
  it('holds an in-range position', () => expect(assessPancakePosition(base)).toMatchObject({ state: 'IN_RANGE', recommendation: 'HOLD', distanceToRangeTicks: 0 }))
  it('recommends directional range relocation only when range is exited', () => {
    expect(assessPancakePosition({ ...base, currentTick: -120 })).toMatchObject({ state: 'BELOW_RANGE', recommendation: 'REBALANCE_UPWARD', distanceToRangeTicks: 20 })
    expect(assessPancakePosition({ ...base, currentTick: 100 })).toMatchObject({ state: 'ABOVE_RANGE', recommendation: 'REBALANCE_DOWNWARD', distanceToRangeTicks: 1 })
  })
  it('does not recommend rebalancing an empty position', () => expect(assessPancakePosition({ ...base, liquidity: '0' })).toMatchObject({ state: 'EMPTY_LIQUIDITY', recommendation: 'NO_ACTION' }))
})
