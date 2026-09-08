import { expect, it } from 'vitest'
import { classifyDeclared, declaredText } from './categories.js'

const of = (name: string, description = '', services: string[] = []) =>
  classifyDeclared(
    declaredText({ name, description, services: services.map((n) => ({ name: n })) }),
  )

it('reads the four judged categories out of real first-party manifests', () => {
  expect(
    of(
      'AiKi Venus Health Factor Guardian',
      'Reads Venus lending positions, derives a health factor, and reports evidence-backed liquidation risk.',
    ),
  ).toBe('health_factor')
  expect(
    of('AiKi PancakeSwap LP Rebalancer', 'Checks whether a v3 position needs rebalancing.'),
  ).toBe('rebalancing')
  expect(
    of('AiKi PancakeSwap Grid Trader', 'Verifies a grid configuration against pool state.'),
  ).toBe('grid_trading')
  expect(
    of(
      'AiKi Venus Yield Optimiser',
      'Reads live supply rates and reports where capital earns most.',
    ),
  ).toBe('yield_optimisation')
})

it('finds the category in a hyphenated service name alone', () => {
  // Without splitting hyphens this is one token and matches nothing.
  expect(of('Agent', '', ['venus-health-factor-assessment'])).toBe('health_factor')
  expect(of('Agent', '', ['pancakeswap-v3-grid-assessment'])).toBe('grid_trading')
})

it('prefers the more specific category when a description mentions both', () => {
  /*
   * An agent that resets an LP range to chase yield is a rebalancer. Calling it
   * a yield optimiser because the word appears later would be worse than
   * calling it neither, so rule order is part of the contract.
   */
  expect(
    of('RangeReset', 'Rebalances concentrated liquidity ranges to capture more yield and apr.'),
  ).toBe('rebalancing')
})

it('says other for a declaration no rule recognises', () => {
  // This is the shape of most of the BSC registry, and it is a measurement.
  expect(of('An EvoEvo AI Agent', 'An EvoEvo AI Agent focused on sports.')).toBe('other')
  expect(of('Q402 Agent', 'Gasless stablecoin payment agent on BNB Chain.')).toBe('other')
  expect(of('BORT AI AGENT', 'BORT AI AGENT ONLY AI')).toBe('other')
  expect(of('', '')).toBe('other')
})

it('is not confused by fields that are not strings', () => {
  expect(declaredText({ name: 42, description: null, services: 'nope' })).toBe('  ')
  expect(declaredText({ services: [{ name: 7 }, null, { name: 'grid-bot' }] })).toContain(
    'grid bot',
  )
})
