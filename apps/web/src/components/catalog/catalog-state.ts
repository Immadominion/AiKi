import type { CatalogCategory, CatalogQuery, CatalogReadResult } from '@/lib/catalog-api'

export const CATALOG_CATEGORIES: { value: CatalogCategory | ''; label: string }[] = [
  { value: '', label: 'All agents' },
  { value: 'health_factor', label: 'Health factor' },
  { value: 'rebalancing', label: 'Rebalancing' },
  { value: 'grid_trading', label: 'Grid trading' },
  { value: 'yield_optimisation', label: 'Yield optimisation' },
  { value: 'other', label: 'Other' },
]

export function catalogFilters(params: URLSearchParams): CatalogQuery {
  const query = params.get('q')?.trim() ?? ''
  const protocol = params.get('protocol') ?? ''
  const category = params.get('category') ?? ''
  const cursor = params.get('cursor') ?? ''
  if (query.length > 160) throw new Error('Search with at most 160 characters.')
  if (protocol && protocol !== 'MCP' && protocol !== 'A2A')
    throw new Error('Choose MCP, A2A or all protocols.')
  if (!CATALOG_CATEGORIES.some((item) => item.value === category))
    throw new Error('Choose one of the marketplace categories.')
  if (cursor && !/^[A-Za-z0-9_=-]{1,1024}$/.test(cursor))
    throw new Error('This page link has expired. Return to the first page.')
  return {
    limit: 24,
    ...(query ? { query } : {}),
    ...(protocol ? { protocol: protocol as 'MCP' | 'A2A' } : {}),
    ...(category ? { category: category as CatalogCategory } : {}),
    ...(cursor ? { cursor } : {}),
  }
}

export function catalogFilterHref(params: URLSearchParams, patch: Record<string, string>): string {
  const next = new URLSearchParams(params)
  next.delete('cursor')
  for (const [key, value] of Object.entries(patch)) {
    if (value) next.set(key, value)
    else next.delete(key)
  }
  return `/explore${next.size ? `?${next}` : ''}`
}

export function readArguments(
  tool: string,
  pool: string,
  address: string,
): Record<string, unknown> {
  if (tool === 'getDexInfo') return { chainName: 'bsc' }
  if (tool === 'getAccountLiquidity') {
    if (pool !== 'CORE' && pool !== 'DEFI') throw new Error('Choose a supported Venus pool.')
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('Sign in with your wallet first.')
    return { chainNames: ['bsc'], pool, userAddress: address }
  }
  throw new Error('This action is not enabled for read-only use.')
}

export function resultText(result: CatalogReadResult): string {
  if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2)
  return result.content
    .map((item) => {
      try {
        return JSON.stringify(JSON.parse(item.text), null, 2)
      } catch {
        return item.text
      }
    })
    .join('\n\n')
}
