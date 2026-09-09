export const CATEGORIES = [
  'health_factor',
  'rebalancing',
  'grid_trading',
  'yield_optimisation',
  'other',
] as const
export type CatalogCategory = (typeof CATEGORIES)[number]
export type JsonObject = Record<string, unknown>

export interface CatalogQuery {
  query?: string
  protocol?: 'MCP' | 'A2A'
  category?: CatalogCategory
  limit?: number
  cursor?: string
}

export interface CatalogAgent {
  id: string
  chainId: 56
  registry: string
  sourceId: string
  name: string
  description: string
  imageUrl: string | null
  ownerAddress: string | null
  declaredProtocols: string[]
  declaredCategories: string[]
  declaredPaymentSupport: boolean
  services: { protocol: 'MCP' | 'A2A'; endpoint: string }[]
  source: { name: '8004scan'; url: string; retrievedAt: string }
  taskAvailability: 'not_verified'
  connector: 'read_only_candidate' | 'discovery_only'
}

export interface CatalogPage {
  items: CatalogAgent[]
  totalRegistered: number
  nextCursor: string | null
  hasMore: boolean
  categoryMatch: 'source_text' | null
  source: '8004scan'
  countMeaning: 'registered_agents_not_verified_working'
}

export interface ReadTool {
  name: string
  label: string
  description: string
  inputSchema: JsonObject
}

export interface CatalogTool {
  name: string
  description: string
  inputSchema: JsonObject
  readAllowed: boolean
}

export interface CatalogCapabilities {
  agentId: string
  status: 'available' | 'auth_required' | 'payment_required' | 'unsupported' | 'unavailable'
  checkedAt: string
  message: string
  protocol: 'MCP' | null
  protocolVersion: string | null
  tools: CatalogTool[]
  readTools: ReadTool[]
  toolsTruncated: boolean
  pricing: 'no_aiki_charge_provider_may_require_payment'
  declaredPaymentSupport: boolean
}

export interface CatalogReadResult {
  agentId: string
  tool: string
  observedAt: string
  chainId: 56
  status: 'completed' | 'provider_error' | 'auth_required' | 'payment_required'
  content: { type: 'text'; text: string }[]
  structuredContent?: JsonObject
  charge: { aikiPoints: 0; providerPaymentMade: false }
  source: { name: string; url: string }
}

export class CatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message)
  }
}

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

export function string(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
