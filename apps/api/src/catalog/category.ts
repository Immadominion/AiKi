import type { CatalogCategory } from './types.js'

/** Text relevance only. These rules never establish execution or availability. */
export function matchesCategoryText(category: CatalogCategory, text: string): boolean {
  const health =
    /\bhealth[\s_-]*factor\b|\bliquidat(?:ion|ions|e|ed)\b/i.test(text) ||
    (/\b(?:lending\s+positions?|borrow(?:ed|ing)?|loans?|debt|collateral)\b/i.test(text) &&
      /\b(?:monitor\w*|watch\w*|risk|repay\w*|protect\w*)\b/i.test(text))
  const rebalance =
    /\brebalanc\w*\b|\b(?:lp|liquidity)\s+range\s+management\b/i.test(text) &&
    /\b(?:liquidity|lp|portfolio|allocations?|tokens?|pancakeswap|uniswap|defi)\b/i.test(text)
  const grid =
    /\bgrid\b/i.test(text) &&
    /\b(?:trad(?:e|es|ing|er|ers)|orders?|dex|amm|swaps?|liquidity|pancake(?:swap)?|spot|futures)\b/i.test(
      text,
    )
  const yieldMatch =
    /\b(?:yields?|apr|apy)\b/i.test(text) &&
    /\b(?:defi|lending|staking|stake|liquidity|vaults?|venus|aave|protocols?|supply|supplied|capital|crypto|tokens?|stablecoins?|usdt|usdc|bnb|eth|trading|dex)\b/i.test(
      text,
    )
  switch (category) {
    case 'health_factor':
      return health
    case 'rebalancing':
      return rebalance
    case 'grid_trading':
      return grid
    case 'yield_optimisation':
      return yieldMatch
    case 'other':
      return !(health || rebalance || grid || yieldMatch)
  }
}
