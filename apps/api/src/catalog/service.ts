import { BoundedCache, WindowBudget } from './bounds.js'
import { connectMcp } from './mcp.js'
import { allowedReadTools, readPolicy, validateRead } from './read-policy.js'
import { boundedText, type CatalogFetch, publicFetch, safeEndpoint } from './transport.js'
import {
  CATEGORIES,
  type CatalogAgent,
  type CatalogCapabilities,
  CatalogError,
  type CatalogPage,
  type CatalogQuery,
  type CatalogReadResult,
  object,
  string,
} from './types.js'

const BASE = 'https://api.8004scan.io/api/v1'
const CATEGORY_SEARCH = {
  health_factor: 'lending',
  rebalancing: 'rebalancing',
  grid_trading: 'grid',
  yield_optimisation: 'yield',
  other: '',
}

export function validateQuery(input: Record<string, unknown>): CatalogQuery {
  if (
    Object.keys(input).some(
      (key) => !['query', 'protocol', 'category', 'limit', 'cursor'].includes(key),
    )
  ) {
    throw new CatalogError(400, 'INVALID_QUERY', 'Unsupported catalog filter.')
  }
  const result: CatalogQuery = {}
  if (input.query !== undefined) {
    if (
      typeof input.query !== 'string' ||
      input.query.length > 160 ||
      [...input.query].some((character) => character.charCodeAt(0) < 32)
    )
      throw new CatalogError(400, 'INVALID_QUERY', 'Use a search of at most 160 characters.')
    if (input.query.trim()) result.query = input.query.trim()
  }
  if (input.protocol !== undefined) {
    if (input.protocol !== 'MCP' && input.protocol !== 'A2A')
      throw new CatalogError(400, 'INVALID_QUERY', 'Choose MCP or A2A.')
    result.protocol = input.protocol
  }
  if (input.category !== undefined) {
    if (!CATEGORIES.includes(input.category as (typeof CATEGORIES)[number]))
      throw new CatalogError(400, 'INVALID_QUERY', 'Choose a supported category.')
    result.category = input.category as (typeof CATEGORIES)[number]
  }
  if (input.limit !== undefined) {
    const limit =
      typeof input.limit === 'string' && /^\d+$/.test(input.limit)
        ? Number(input.limit)
        : input.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 40)
      throw new CatalogError(400, 'INVALID_QUERY', 'Page size must be between 1 and 40.')
    result.limit = limit
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_=-]{1,1024}$/.test(input.cursor))
      throw new CatalogError(400, 'INVALID_QUERY', 'The page cursor is invalid.')
    result.cursor = input.cursor
  }
  return result
}

export function validateId(id: string): string {
  if (!/^(0|[1-9]\d{0,77})$/.test(id) || BigInt(id) >= 2n ** 256n)
    throw new CatalogError(400, 'INVALID_AGENT_ID', 'Use the registered BNB Chain agent ID.')
  return id
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 24)
        .map((item) => item.slice(0, 100))
    : []
}

export function normalizeAgent(input: unknown, now = Date.now()): CatalogAgent {
  const row = object(input)
  const id = validateId(string(row.token_id, 78))
  if (
    row.chain_id !== 56 ||
    row.is_testnet === true ||
    !/^0x[a-fA-F0-9]{40}$/.test(string(row.contract_address))
  ) {
    throw new CatalogError(
      502,
      'INVALID_CATALOG_DATA',
      'The catalog returned an invalid BNB Chain registration.',
    )
  }
  const services: CatalogAgent['services'] = []
  const normalizedServices = object(row.services)
  const metadata = object(object(row.raw_metadata).offchain_content)
  for (const protocol of ['MCP', 'A2A'] as const) {
    const raw = Array.isArray(metadata.services)
      ? metadata.services.find((item) => string(object(item).name).toUpperCase() === protocol)
      : undefined
    const endpoint = string(
      object(raw).endpoint ||
        object(normalizedServices[protocol.toLowerCase()]).endpoint ||
        (protocol === 'MCP' ? row.mcp_server : row.a2a_endpoint),
      2049,
    )
    if (endpoint) {
      try {
        services.push({ protocol, endpoint: safeEndpoint(endpoint).href })
      } catch {
        /* Unsafe registrations remain browsable, never callable. */
      }
    }
  }
  const registry = string(row.contract_address).toLowerCase()
  const sourceId = `56:${registry}:${id}`
  if (row.agent_id !== undefined && row.agent_id !== sourceId)
    throw new CatalogError(
      502,
      'INVALID_CATALOG_DATA',
      'The catalog returned conflicting identity fields.',
    )
  const agent: CatalogAgent = {
    id,
    chainId: 56,
    registry,
    sourceId,
    name: string(row.name, 200) || `Agent #${id}`,
    description: string(row.description, 4000),
    imageUrl: row.image_url || metadata.image ? `${BASE}/media/agents/56/${id}/image` : null,
    ownerAddress: /^0x[a-fA-F0-9]{40}$/.test(string(row.owner_address))
      ? string(row.owner_address).toLowerCase()
      : null,
    declaredProtocols: strings(row.supported_protocols),
    declaredCategories: strings(row.categories),
    declaredPaymentSupport: row.x402_supported === true || metadata.x402Support === true,
    services,
    source: {
      name: '8004scan',
      url: `https://8004scan.io/agents/bsc/${id}`,
      retrievedAt: new Date(now).toISOString(),
    },
    taskAvailability: 'not_verified',
    connector: 'discovery_only',
  }
  if (readPolicy(agent)) agent.connector = 'read_only_candidate'
  return agent
}

export interface CatalogServiceOptions {
  fetcher?: CatalogFetch
  now?: () => number
}

interface SourceSnapshot {
  data: unknown
  retrievedAt: number
}

export class CatalogService {
  private readonly fetcher: CatalogFetch
  private readonly now: () => number
  private readonly sourceCache: BoundedCache<SourceSnapshot>
  private readonly capabilityCache: BoundedCache<CatalogCapabilities>
  private readonly upstreamMinute: WindowBudget
  private readonly upstreamDay: WindowBudget
  private readonly providerBudget: WindowBudget
  private upstreamPausedUntil = 0

  constructor(options: CatalogServiceOptions = {}) {
    this.fetcher = options.fetcher ?? publicFetch
    this.now = options.now ?? Date.now
    const size = (value: unknown) => JSON.stringify(value).length * 2
    this.sourceCache = new BoundedCache<SourceSnapshot>(
      256,
      5 * 60_000,
      this.now,
      size,
      16 * 1024 * 1024,
    )
    this.capabilityCache = new BoundedCache<CatalogCapabilities>(
      128,
      2 * 60_000,
      this.now,
      size,
      8 * 1024 * 1024,
    )
    this.upstreamMinute = new WindowBudget(24, 60_000, 1, this.now)
    this.upstreamDay = new WindowBudget(900, 86_400_000, 1, this.now)
    this.providerBudget = new WindowBudget(30, 60_000, 1, this.now)
  }

  private source(path: string): Promise<SourceSnapshot> {
    return this.sourceCache.get(path, async () => {
      if (this.now() < this.upstreamPausedUntil)
        throw new CatalogError(
          429,
          'CATALOG_SOURCE_RATE_LIMIT',
          'The source catalog is rate limited. Please try again later.',
          Math.ceil((this.upstreamPausedUntil - this.now()) / 1000),
        )
      this.upstreamMinute.take('source')
      this.upstreamDay.take('source')
      const response = await this.fetcher(new URL(`${BASE}${path}`), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 404)
          throw new CatalogError(404, 'AGENT_NOT_FOUND', 'No such BNB Chain registration.')
        if (response.status === 429) {
          const retry = response.headers.get('retry-after') ?? ''
          const seconds = /^\d+$/.test(retry)
            ? Number(retry)
            : (Date.parse(retry) - this.now()) / 1000
          const wait = Number.isFinite(seconds) ? Math.max(60, Math.min(seconds, 86_400)) : 60
          this.upstreamPausedUntil = this.now() + wait * 1000
          throw new CatalogError(
            429,
            'CATALOG_SOURCE_RATE_LIMIT',
            'The source catalog is rate limited. Please try again later.',
            Math.ceil(wait),
          )
        }
        throw new CatalogError(
          502,
          'CATALOG_SOURCE_UNAVAILABLE',
          'The source catalog is temporarily unavailable.',
        )
      }
      try {
        return {
          data: JSON.parse(await boundedText(response, 2 * 1024 * 1024)) as unknown,
          retrievedAt: this.now(),
        }
      } catch (error) {
        if (error instanceof CatalogError) throw error
        throw new CatalogError(
          502,
          'INVALID_CATALOG_DATA',
          'The source catalog returned invalid data.',
        )
      }
    })
  }

  async list(input: CatalogQuery): Promise<CatalogPage> {
    const query = validateQuery(input as Record<string, unknown>)
    const params = new URLSearchParams({
      chain_id: '56',
      limit: String(query.limit ?? 24),
      sort_by: 'token_id',
      sort_order: 'desc',
      is_registered: 'true',
      is_active: 'true',
    })
    if (query.protocol) params.set('supported_protocol', query.protocol)
    const search = [query.query, query.category ? CATEGORY_SEARCH[query.category] : '']
      .filter(Boolean)
      .join(' ')
    if (search) {
      params.set('search', search)
      params.set('search_type', 'text')
    }
    if (query.cursor) params.set('cursor', query.cursor)
    const snapshot = await this.source(`/agents?${params}`)
    const data = object(snapshot.data)
    if (!Array.isArray(data.items))
      throw new CatalogError(502, 'INVALID_CATALOG_DATA', 'The source catalog returned no list.')
    const items: CatalogAgent[] = []
    const seen = new Set<string>()
    for (const raw of data.items.slice(0, query.limit ?? 24)) {
      try {
        const agent = normalizeAgent(raw, snapshot.retrievedAt)
        if (!seen.has(agent.sourceId)) {
          seen.add(agent.sourceId)
          items.push(agent)
        }
      } catch {
        /* Reject malformed identities without manufacturing a substitute. */
      }
    }
    // The source list does not include category metadata. Other is a source-text
    // filter on this page, not a claim that the publisher declared no category.
    const filtered =
      query.category === 'other'
        ? items.filter(
            (agent) =>
              !/health\s*factor|liquidat|lending|rebalanc|grid|yield/i.test(
                `${agent.name} ${agent.description}`,
              ),
          )
        : items
    const cursor = string(data.next_cursor, 1025)
    return {
      items: filtered,
      totalRegistered:
        typeof data.total === 'number' && Number.isSafeInteger(data.total) && data.total >= 0
          ? data.total
          : 0,
      nextCursor: /^[A-Za-z0-9_=-]{1,1024}$/.test(cursor) ? cursor : null,
      hasMore: data.has_more === true && Boolean(cursor),
      categoryMatch: query.category ? 'source_text' : null,
      source: '8004scan',
      countMeaning: 'registered_agents_not_verified_working',
    }
  }

  async detail(id: string): Promise<CatalogAgent> {
    validateId(id)
    const snapshot = await this.source(`/agents/56/${id}`)
    const agent = normalizeAgent(snapshot.data, snapshot.retrievedAt)
    if (agent.id !== id)
      throw new CatalogError(
        502,
        'INVALID_CATALOG_DATA',
        'The source returned a different registration.',
      )
    return agent
  }

  async capabilities(id: string): Promise<CatalogCapabilities> {
    validateId(id)
    return this.capabilityCache.get(id, async () => {
      const agent = await this.detail(id)
      const endpoint = agent.services.find((item) => item.protocol === 'MCP')?.endpoint
      const base: CatalogCapabilities = {
        agentId: id,
        status: 'unsupported',
        checkedAt: new Date(this.now()).toISOString(),
        message:
          'This registration has no supported HTTPS MCP endpoint. A2A listings remain browsable.',
        protocol: endpoint ? 'MCP' : null,
        protocolVersion: null,
        tools: [],
        readTools: [],
        toolsTruncated: false,
        pricing: 'no_aiki_charge_provider_may_require_payment',
        declaredPaymentSupport: agent.declaredPaymentSupport,
      }
      if (!endpoint) return base
      this.providerBudget.take('provider')
      try {
        const session = await connectMcp(endpoint, this.fetcher)
        try {
          const readTools = allowedReadTools(agent, session.tools)
          return {
            ...base,
            status: 'available',
            protocolVersion: session.version,
            message: readTools.length
              ? 'Read-only actions are available. No AiKi points are charged.'
              : 'The provider answered MCP discovery. Its tools are not enabled for execution in AiKi.',
            tools: session.tools.map((tool) => ({
              ...tool,
              readAllowed: readTools.some((read) => read.name === tool.name),
            })),
            readTools,
            toolsTruncated: session.truncated,
          }
        } finally {
          session.close()
        }
      } catch (error) {
        if (error instanceof CatalogError && error.status === 429) throw error
        return {
          ...base,
          status:
            error instanceof CatalogError && error.code === 'PROVIDER_AUTH_REQUIRED'
              ? 'auth_required'
              : error instanceof CatalogError && error.code === 'PROVIDER_PAYMENT_REQUIRED'
                ? 'payment_required'
                : 'unavailable',
          message:
            error instanceof CatalogError
              ? error.message
              : 'The provider did not complete discovery within the request limit.',
        }
      }
    })
  }

  async read(id: string, tool: string, args: unknown, wallet: string): Promise<CatalogReadResult> {
    const agent = await this.detail(id)
    const policy = readPolicy(agent)
    if (!policy?.tools.some((entry) => entry.name === tool))
      throw new CatalogError(
        403,
        'TOOL_NOT_ALLOWED',
        'This registration has no enabled read-only connector for that tool.',
      )
    // Validate the fixed local policy before even contacting the provider.
    validateRead(
      agent,
      policy.tools.map((item) => ({ ...item, readAllowed: true })),
      tool,
      args,
      wallet,
    )
    this.providerBudget.take('provider')
    const base = {
      agentId: id,
      tool,
      chainId: 56 as const,
      observedAt: new Date(this.now()).toISOString(),
      charge: { aikiPoints: 0 as const, providerPaymentMade: false as const },
      source: { name: agent.name, url: agent.source.url },
    }
    try {
      const session = await connectMcp(policy.endpoint, this.fetcher)
      try {
        const arguments_ = validateRead(agent, session.tools, tool, args, wallet)
        const result = await session.call(tool, arguments_)
        const content: CatalogReadResult['content'] = []
        let remaining = 32_000
        for (const raw of (Array.isArray(result.content) ? result.content : []).slice(0, 20)) {
          const item = object(raw)
          if (item.type === 'text' && typeof item.text === 'string' && remaining > 0) {
            const text = item.text.slice(0, remaining)
            remaining -= text.length
            content.push({ type: 'text', text })
          }
        }
        const structuredContent = object(result.structuredContent)
        const structured =
          JSON.stringify(structuredContent).length <= 32_000 &&
          Object.keys(structuredContent).length
            ? structuredContent
            : undefined
        if (!content.length && !structured)
          throw new CatalogError(
            502,
            'EMPTY_PROVIDER_RESULT',
            'The provider returned no supported result content.',
          )
        return {
          ...base,
          observedAt: new Date(this.now()).toISOString(),
          status: result.isError === true ? 'provider_error' : 'completed',
          content,
          ...(structured ? { structuredContent: structured } : {}),
        }
      } finally {
        session.close()
      }
    } catch (error) {
      if (
        error instanceof CatalogError &&
        ['PROVIDER_AUTH_REQUIRED', 'PROVIDER_PAYMENT_REQUIRED'].includes(error.code)
      ) {
        return {
          ...base,
          status: error.code === 'PROVIDER_AUTH_REQUIRED' ? 'auth_required' : 'payment_required',
          content: [{ type: 'text', text: error.message }],
        }
      }
      throw error
    }
  }
}
