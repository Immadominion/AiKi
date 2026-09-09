import type Anthropic from '@anthropic-ai/sdk'
import { validateId, validateQuery } from './service.js'
import { CatalogError, type JsonObject, object, string } from './types.js'

export const CATALOG_TOOLS: Anthropic.Tool[] = [
  {
    name: 'catalog_agents',
    description:
      'Browse or search actual BNB Chain ERC-8004 registrations through 8004scan, beyond AiKi’s own index. Returns publisher metadata, not verified hiring availability. Paginated source counts are registrations, not working agents. Link results using their returned /catalog/ID path.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 160 },
        protocol: { type: 'string', enum: ['MCP', 'A2A'] },
        category: {
          type: 'string',
          enum: ['health_factor', 'rebalancing', 'grid_trading', 'yield_optimisation', 'other'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 12 },
        cursor: { type: 'string', maxLength: 1024 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'catalog_agent',
    description:
      'Read a real external registration’s current source metadata, declared endpoints and registered owner. Creates no hire. For known read connectors, inspect BSC 43129 (HeyAnon Venus) or 45650 (HeyAnon V3 Pools); these are distinct from AiKi reference agents 315943–315946.',
    input_schema: {
      type: 'object',
      properties: { agent_id: { type: 'string' } },
      required: ['agent_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'catalog_capabilities',
    description:
      'Check an external registration using MCP initialize and tools/list, without running provider actions. Reports readTools that AiKi explicitly enables, and authentication/payment requirements. Available discovery is not a paid-hire guarantee. No arbitrary MCP tool execution.',
    input_schema: {
      type: 'object',
      properties: { agent_id: { type: 'string' } },
      required: ['agent_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_external_agent',
    description:
      'Run one reviewed external BNB mainnet read after checking catalog_capabilities. Agent 43129 reads the signed-in wallet’s Venus account liquidity (CORE or DEFI pool); agent 45650 reads supported BNB DEX/pool information. No transaction, signing, permission, hired job or provider payment. The connector charges zero AiKi points, but Fast model usage is billed separately. User requests for those reads authorize the read, not any trading action.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', enum: ['43129', '45650'] },
        pool: {
          type: 'string',
          enum: ['CORE', 'DEFI'],
          description: 'Venus 43129 only. Defaults to CORE.',
        },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
  },
]

interface CallResult {
  ok: boolean
  body: unknown
}
type Loopback = (path: string, body?: unknown) => Promise<CallResult>

/** Narrow model-facing inputs; the authenticated HTTP route remains authoritative. */
export async function runCatalogTool(
  name: string,
  args: JsonObject,
  sessionAddress: string | undefined,
  call: Loopback,
): Promise<CallResult | null> {
  if (!CATALOG_TOOLS.some((tool) => tool.name === name)) return null
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new CatalogError(
        400,
        'INVALID_TOOL_ARGUMENTS',
        'Provide an object with the supported parameters.',
      )
    if (name === 'catalog_agents') {
      const query = validateQuery(args)
      if ((query.limit ?? 8) > 12)
        throw new CatalogError(
          400,
          'INVALID_QUERY',
          'Read at most 12 registrations in one Fast request.',
        )
      const params = new URLSearchParams({ limit: String(query.limit ?? 8) })
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) params.set(key, String(value))
      const response = await call(`/v1/catalog/agents?${params}`)
      if (!response.ok) return response
      const data = object(response.body)
      return {
        ok: true,
        body: {
          ...data,
          items: (Array.isArray(data.items) ? data.items : []).slice(0, 12).map((raw) => {
            const agent = object(raw)
            const id = validateId(string(agent.id))
            return {
              id,
              name: agent.name,
              description: string(agent.description, 500),
              declaredProtocols: agent.declaredProtocols,
              taskAvailability: agent.taskAvailability,
              connector: agent.connector,
              href: `/catalog/${id}`,
              source: agent.source,
            }
          }),
        },
      }
    }
    const allowed = name === 'read_external_agent' ? ['agent_id', 'pool'] : ['agent_id']
    if (
      Object.keys(args).some((key) => !allowed.includes(key)) ||
      typeof args.agent_id !== 'string'
    )
      throw new CatalogError(
        400,
        'INVALID_TOOL_ARGUMENTS',
        'Use only the supported agent parameters.',
      )
    const id = validateId(args.agent_id)
    if (name === 'catalog_agent') {
      const response = await call(`/v1/catalog/agents/${id}`)
      if (!response.ok) return response
      const agent = object(response.body)
      return {
        ok: true,
        body: { ...agent, description: string(agent.description, 1800), href: `/catalog/${id}` },
      }
    }
    if (name === 'catalog_capabilities') {
      const response = await call(`/v1/catalog/agents/${id}/capabilities`)
      if (!response.ok) return response
      const data = object(response.body)
      const tools = Array.isArray(data.tools) ? data.tools : []
      return {
        ok: true,
        body: {
          ...data,
          href: `/catalog/${id}`,
          discoveredToolsOnPage: tools.length,
          tools: tools.slice(0, 24).map((raw) => {
            const tool = object(raw)
            return {
              name: tool.name,
              description: string(tool.description, 160),
              readAllowed: tool.readAllowed,
            }
          }),
          toolSummaryTruncated: tools.length > 24 || data.toolsTruncated === true,
        },
      }
    }
    if (id !== '43129' && id !== '45650')
      throw new CatalogError(
        403,
        'TOOL_NOT_ALLOWED',
        'Only the reviewed external read connectors are enabled.',
      )
    if (!sessionAddress || !/^0x[a-fA-F0-9]{40}$/.test(sessionAddress))
      throw new CatalogError(
        401,
        'UNAUTHENTICATED',
        'Sign in with your wallet before running this read.',
      )
    if (
      args.pool !== undefined &&
      (id !== '43129' || typeof args.pool !== 'string' || !['CORE', 'DEFI'].includes(args.pool))
    )
      throw new CatalogError(
        400,
        'INVALID_TOOL_ARGUMENTS',
        'Choose CORE or DEFI for the Venus read only.',
      )
    const body =
      id === '43129'
        ? {
            tool: 'getAccountLiquidity',
            arguments: {
              chainNames: ['bsc'],
              pool: args.pool ?? 'CORE',
              userAddress: sessionAddress.toLowerCase(),
            },
          }
        : { tool: 'getDexInfo', arguments: { chainName: 'bsc' } }
    const response = await call(`/v1/catalog/agents/${id}/read`, body)
    const data = object(response.body)
    return { ok: response.ok && data.status === 'completed', body: response.body }
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error
    return {
      ok: false,
      body: { error: { code: error.code, message: error.message, retryable: false } },
    }
  }
}
