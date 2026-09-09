import { apiRequest } from './api'

export type CatalogCategory =
  | 'health_factor'
  | 'rebalancing'
  | 'grid_trading'
  | 'yield_optimisation'
  | 'other'
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
export interface CatalogQuery {
  query?: string
  protocol?: 'MCP' | 'A2A'
  category?: CatalogCategory
  limit?: number
  cursor?: string
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
export interface CatalogReadTool {
  name: string
  label: string
  description: string
  inputSchema: Record<string, unknown>
}
export interface CatalogCapabilities {
  agentId: string
  status: 'available' | 'auth_required' | 'payment_required' | 'unsupported' | 'unavailable'
  checkedAt: string
  message: string
  protocol: 'MCP' | null
  protocolVersion: string | null
  tools: {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    readAllowed: boolean
  }[]
  readTools: CatalogReadTool[]
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
  structuredContent?: Record<string, unknown>
  charge: { aikiPoints: 0; providerPaymentMade: false }
  source: { name: string; url: string }
}

const path = (id: string) => `/v1/catalog/agents/${encodeURIComponent(id)}`

/** Uses the shared accepted-wallet/session-revision guard for every response. */
export const catalogApi = {
  list(query: CatalogQuery = {}, signal?: AbortSignal): Promise<CatalogPage> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    return apiRequest(`/v1/catalog/agents?${params}`, signal ? { signal } : undefined)
  },
  detail(id: string, signal?: AbortSignal): Promise<CatalogAgent> {
    return apiRequest(path(id), signal ? { signal } : undefined)
  },
  capabilities(id: string, signal?: AbortSignal): Promise<CatalogCapabilities> {
    return apiRequest(`${path(id)}/capabilities`, signal ? { signal } : undefined)
  },
  read(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CatalogReadResult> {
    return apiRequest(`${path(id)}/read`, {
      method: 'POST',
      body: JSON.stringify({ tool, arguments: args }),
      ...(signal ? { signal } : {}),
    })
  },
}
