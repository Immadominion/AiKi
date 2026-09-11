import { connectMcp } from '../catalog/mcp.js'
import { CatalogError } from '../catalog/types.js'
import type { guardedFetch } from '../net/guard.js'
import { type DeclaredService, d2_placeholderUrl, type ProbeVerdict } from './detect.js'

export const isMcpService = (service: DeclaredService) =>
  service.name.trim().toUpperCase() === 'MCP' && service.transport !== 'stdio'

/** Match the actual HTTP destination, including host/default-port and fragment aliases. */
export function canonicalProbeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    url.hash = ''
    return url.href
  } catch {
    return endpoint
  }
}

/**
 * Capability discovery only. No advertised tool (including read tools) is called.
 * MCP permits GET 405; its lifecycle and tools/list use JSON-RPC POST:
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 * https://modelcontextprotocol.io/specification/2025-06-18/server/tools
 */
export async function probeMcpEndpoint(
  endpoint: string,
  read: typeof guardedFetch,
): Promise<ProbeVerdict> {
  const evidence = { protocol: 'MCP', endpoint, protocolAvailable: false }
  const placeholder = d2_placeholderUrl(endpoint)
  if (placeholder) return { ...placeholder, evidence: { ...evidence, ...placeholder.evidence } }
  try {
    const session = await connectMcp(endpoint, (url, init) => {
      // An explicit transport boundary, not reliance on tool descriptions or
      // provider annotations: future connector changes cannot execute work here.
      const request = typeof init.body === 'string' ? JSON.parse(init.body) : null
      if (
        init.method !== 'POST' ||
        !['initialize', 'notifications/initialized', 'tools/list'].includes(request?.method)
      )
        throw new Error('Only MCP capability discovery is allowed.')
      return read(url.href, init)
    })
    try {
      const toolCount = session.tools.filter((tool) => tool.inputSchema.type === 'object').length
      return {
        state: 'DEGRADED',
        rule: toolCount ? 'MCP-identity-unproven' : 'MCP-no-tools',
        detail: toolCount
          ? 'MCP capability discovery succeeded. The endpoint has not yet proven this registered identity. No tool was called.'
          : 'MCP capability discovery succeeded but returned no usable tool definitions. No tool was called.',
        evidence: {
          ...evidence,
          protocolAvailable: true,
          protocolVersion: session.version,
          toolCount,
          toolsTruncated: session.truncated,
          toolsCalled: 0,
        },
      }
    } finally {
      session.close()
    }
  } catch (error) {
    const code = error instanceof CatalogError ? error.code : 'PROVIDER_UNAVAILABLE'
    const access =
      code === 'PROVIDER_PAYMENT_REQUIRED'
        ? 'payment'
        : code === 'PROVIDER_AUTH_REQUIRED'
          ? 'authentication'
          : null
    return {
      state: code === 'PROVIDER_UNAVAILABLE' ? 'UNREACHABLE' : 'DEGRADED',
      rule: access ? `MCP-${access}-required` : 'MCP-unverified',
      detail: access
        ? `The MCP endpoint requires ${access}. No credentials or payment were supplied and no tool was called.`
        : 'MCP capability discovery could not be verified. This is not proof that every service offered by the provider is unavailable.',
      evidence: { ...evidence, errorCode: code, ...(access ? { accessRequired: access } : {}) },
    }
  }
}
