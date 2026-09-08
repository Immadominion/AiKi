import { expect, it } from 'vitest'
import { InMemoryEvidenceStore } from '../../evidence/store.js'
import { assessPancakePosition } from './client.js'
import { persistPancakeAssessment } from './evidence-sink.js'

it('persists an immutable rebalancing assessment', async () => {
  const store = new InMemoryEvidenceStore()
  const assessment = assessPancakePosition({
    tokenId: '42',
    owner: '0x1111111111111111111111111111111111111111',
    token0: '0x2222222222222222222222222222222222222222',
    token1: '0x3333333333333333333333333333333333333333',
    fee: 500,
    tickLower: -100,
    tickUpper: 100,
    liquidity: '123',
    tokensOwed0: '0',
    tokensOwed1: '0',
    currentTick: 0,
    pool: '0x4444444444444444444444444444444444444444',
    observedAt: '2026-08-22T00:00:00.000Z',
  })
  expect(
    await persistPancakeAssessment(store, {
      agentId: '456',
      assessment,
      registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      chainId: 56,
    }),
  ).toBe(true)
  expect(store.observations[0]?.predicate).toBe('pancakeswap.rebalance_assessment')
})
