import { isAddress } from 'viem'
import type { CatalogAgent, CatalogTool, JsonObject, ReadTool } from './types.js'
import { CatalogError, object } from './types.js'

const REGISTRY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'
const OWNER = '0xda977767452c5dd021624511f14df67b6c9c2c1b'
const POLICIES: Record<string, { endpoint: string; tools: ReadTool[] }> = {
  '43129': {
    endpoint: 'https://erc8004.heyanon.ai/mcp/venus',
    tools: [
      {
        name: 'getAccountLiquidity',
        label: 'Read my lending position',
        description:
          'Read this signed-in wallet’s Venus account liquidity on BNB Chain. No transaction or fund movement.',
        inputSchema: {
          type: 'object',
          properties: {
            chainNames: {
              type: 'array',
              items: { type: 'string', enum: ['bsc'] },
              minItems: 1,
              maxItems: 1,
            },
            pool: { type: 'string', enum: ['CORE', 'DEFI'] },
            userAddress: { type: 'string', maxLength: 42 },
          },
          required: ['chainNames', 'pool', 'userAddress'],
          additionalProperties: false,
        },
      },
    ],
  },
  '45650': {
    endpoint: 'https://erc8004.heyanon.ai/mcp/v3pools',
    tools: [
      {
        name: 'getDexInfo',
        label: 'Explore BNB Chain pools',
        description:
          'Read the provider’s supported BNB Chain DEX and pool information. No swap or liquidity transaction.',
        inputSchema: {
          type: 'object',
          properties: { chainName: { type: 'string', enum: ['bsc'] } },
          required: ['chainName'],
          additionalProperties: false,
        },
      },
    ],
  },
}

export function readPolicy(agent: CatalogAgent) {
  const policy = POLICIES[agent.id]
  return policy &&
    agent.chainId === 56 &&
    agent.registry.toLowerCase() === REGISTRY &&
    agent.ownerAddress?.toLowerCase() === OWNER &&
    agent.services.some(
      (service) => service.protocol === 'MCP' && service.endpoint === policy.endpoint,
    )
    ? policy
    : null
}

/** Restricted JSON Schema evaluator. Unsupported validation keywords fail closed. */
export function matchesSchema(value: unknown, input: JsonObject, depth = 0): boolean {
  if (depth > 8) return false
  const allowed = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'anyOf',
    'oneOf',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'title',
    'description',
    'default',
    'examples',
    '$schema',
  ])
  if (Object.keys(input).some((key) => !allowed.has(key))) return false
  if (input.anyOf) {
    return (
      Array.isArray(input.anyOf) &&
      input.anyOf.some((schema) => matchesSchema(value, object(schema), depth + 1))
    )
  }
  if (input.oneOf) {
    return (
      Array.isArray(input.oneOf) &&
      input.oneOf.filter((schema) => matchesSchema(value, object(schema), depth + 1)).length === 1
    )
  }
  if (Array.isArray(input.enum) && !input.enum.includes(value)) return false
  if ('const' in input && input.const !== value) return false
  switch (input.type) {
    case 'null':
      return value === null
    case 'string':
      return (
        typeof value === 'string' &&
        value.length <= Number(input.maxLength ?? 2048) &&
        value.length >= Number(input.minLength ?? 0)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
    case 'array':
      return (
        Array.isArray(value) &&
        value.length <= Math.min(Number(input.maxItems ?? 20), 20) &&
        value.length >= Number(input.minItems ?? 0) &&
        value.every((item) => matchesSchema(item, object(input.items), depth + 1))
      )
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
      const data = value as JsonObject
      const properties = object(input.properties)
      if (Object.keys(data).some((key) => !Object.hasOwn(properties, key))) return false
      if (
        Array.isArray(input.required) &&
        input.required.some((key) => typeof key !== 'string' || !Object.hasOwn(data, key))
      )
        return false
      return Object.entries(data).every(([key, item]) =>
        matchesSchema(item, object(properties[key]), depth + 1),
      )
    }
    default:
      return false
  }
}

export function allowedReadTools(agent: CatalogAgent, tools: CatalogTool[]): ReadTool[] {
  return (readPolicy(agent)?.tools ?? []).filter((policy) => {
    const tool = tools.find((candidate) => candidate.name === policy.name)
    if (!tool) return false
    // A changed or unsupported remote schema does not silently widen the connector.
    const example =
      policy.name === 'getAccountLiquidity'
        ? {
            chainNames: ['bsc'],
            pool: 'CORE',
            userAddress: '0x1111111111111111111111111111111111111111',
          }
        : { chainName: 'bsc' }
    return matchesSchema(example, tool.inputSchema)
  })
}

export function validateRead(
  agent: CatalogAgent,
  tools: CatalogTool[],
  name: string,
  args: unknown,
  wallet: string,
): JsonObject {
  const policy = allowedReadTools(agent, tools).find((tool) => tool.name === name)
  const remote = tools.find((tool) => tool.name === name)
  if (!policy || !remote) {
    throw new CatalogError(
      403,
      'TOOL_NOT_ALLOWED',
      'This tool is not enabled for read-only use in AiKi.',
    )
  }
  if (!matchesSchema(args, policy.inputSchema) || !matchesSchema(args, remote.inputSchema)) {
    throw new CatalogError(
      400,
      'INVALID_TOOL_ARGUMENTS',
      'Use the supported BNB Chain read parameters.',
    )
  }
  const data = object(args)
  if (name === 'getAccountLiquidity') {
    if (
      typeof data.userAddress !== 'string' ||
      !isAddress(data.userAddress) ||
      data.userAddress.toLowerCase() !== wallet.toLowerCase()
    ) {
      throw new CatalogError(
        403,
        'WALLET_MISMATCH',
        'Read the position of the wallet signed in to AiKi.',
      )
    }
  }
  return data
}
