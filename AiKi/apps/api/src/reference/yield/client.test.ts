import { expect, it } from 'vitest'
import { assessYield } from './client.js'
const routes = [{ market: '0x1111111111111111111111111111111111111111' as const, symbol: 'vA', supplyRatePerBlock: '1', simpleAnnualRateBps: '10' }, { market: '0x2222222222222222222222222222222222222222' as const, symbol: 'vB', supplyRatePerBlock: '2', simpleAnnualRateBps: '20' }]
it('does not call a rate-only comparison optimisation unless explicitly requested', () => {
  expect(assessYield(routes, false).recommendation).toBe('INSUFFICIENT_EVIDENCE')
  expect(assessYield(routes, true)).toMatchObject({ recommendation: 'RATE_ONLY_CANDIDATE', recommendedMarket: routes[1]?.market })
})
