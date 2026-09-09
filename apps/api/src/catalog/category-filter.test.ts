import { describe, expect, it } from 'vitest'
import { CatalogService } from './service.js'
import type { CatalogCategory } from './types.js'

const records = [
  ['1', 'Health Factor Monitor', 'Monitor Venus lending positions and liquidation risk.'],
  ['2', 'Personal health monitor', 'A guide to skincare, fitness and healthy living.'],
  ['3', 'LP Range Agent', 'Rebalancing PancakeSwap v3 liquidity positions.'],
  ['4', 'Yin Yang', 'Rebalancing your spiritual energies through metaphysics.'],
  ['5', 'Grid Agent', 'A grid trading bot for BSC spot markets.'],
  ['6', 'Energy Grid', 'A token for energy grid access.'],
  ['7', 'Website designer', 'Create a landing page with a features grid.'],
  ['8', 'Yield Monitor', 'Compare Venus supply APY and lending yields.'],
  ['9', 'Crop yield', 'Analyse crop yield and agricultural weather.'],
  ['10', 'DEX Grid', 'Manages buy and sell orders in a price grid on PancakeSwap.'],
  ['11', 'Portfolio Manager', 'Rebalance token allocations in your portfolio.'],
  ['12', 'Staking scout', 'Find the best staking APR.'],
]

function service() {
  return new CatalogService({
    fetcher: async () =>
      Response.json({
        items: records.map(([id, name, description]) => ({
          token_id: id,
          chain_id: 56,
          contract_address: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
          name,
          description,
        })),
        total: 100,
        has_more: true,
        next_cursor: 'source_next_page',
      }),
  })
}

describe('finance-specific category matches', () => {
  it.each<[CatalogCategory, string[]]>([
    ['health_factor', ['1']],
    ['rebalancing', ['3', '11']],
    ['grid_trading', ['5', '10']],
    ['yield_optimisation', ['8', '12']],
    ['other', ['2', '4', '6', '7', '9']],
  ])('filters %s by financial context, not an unrelated matching word', async (category, ids) => {
    const page = await service().list({ category })
    expect(page.items.map((agent) => agent.id)).toEqual(ids)
    expect(page.categoryMatch).toBe('source_text')
    expect(page.countMeaning).toBe('registered_agents_not_verified_working')
    expect(page.totalRegistered).toBe(100)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('source_next_page')
    expect(page.items.every((agent) => agent.taskAvailability === 'not_verified')).toBe(true)
  })

  it('does not remove non-financial registrations from the unfiltered catalog', async () => {
    const page = await service().list({})
    expect(page.items).toHaveLength(records.length)
    expect(page.categoryMatch).toBeNull()
  })
})
