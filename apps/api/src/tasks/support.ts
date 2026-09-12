import { connectMcp } from '../catalog/mcp.js'
import { guardedFetch } from '../net/guard.js'
import { DISPATCH_PROTOCOL } from './dispatch.js'
import { isTaskKind } from './kinds.js'

/** What a hired agent is reached over. AiKi's own envelope, or plain MCP. */
export type TaskTransport = typeof DISPATCH_PROTOCOL | 'mcp'

export interface AgentTaskContact {
  owner: string
  endpoint: string
  live: boolean
  /** Production always sets this. Optional only for existing injected test contacts. */
  compatible?: boolean
  reason?: string
  protocol?: string
  inputHint?: string
  kinds?: string[]
  /**
   * What the agent advertises over MCP, when that is how it is reached.
   *
   * Carried because there is no convention for which tool does the work, and
   * guessing with somebody's money is not a convention. The buyer picks, and
   * they can only pick from what the agent is advertising right now.
   */
  tools?: { name: string; description: string }[]
}

const MAX_CAPABILITY_BYTES = 16_384

async function capability(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
    await response.body?.cancel()
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_CAPABILITY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } finally {
    reader.releaseLock()
  }
}

/** Read registered endpoints only; HTTP liveness by itself is not a hiring protocol. */
export async function resolveTaskEndpoint(
  services: unknown,
  read: typeof guardedFetch = guardedFetch,
  connect: typeof connectMcp = connectMcp,
): Promise<Omit<AgentTaskContact, 'owner' | 'live'>> {
  const endpoints = Array.isArray(services)
    ? [
        ...new Set(
          services
            .map((service) => service?.endpoint)
            .filter(
              (endpoint): endpoint is string =>
                typeof endpoint === 'string' && /^https?:\/\//i.test(endpoint),
            ),
        ),
      ]
        .sort()
        .slice(0, 8)
    : []
  const answers = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const metadata = await capability(
          await read(endpoint, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(4_000),
          }),
        )
        if (metadata?.taskProtocol !== DISPATCH_PROTOCOL) return null
        const inputHint =
          typeof metadata.taskInputHint === 'string'
            ? metadata.taskInputHint.trim().slice(0, 300)
            : undefined
        const kinds = Array.isArray(metadata.taskKinds)
          ? metadata.taskKinds.filter(isTaskKind)
          : undefined
        return {
          endpoint,
          compatible: true,
          protocol: DISPATCH_PROTOCOL,
          ...(inputHint ? { inputHint } : {}),
          ...(kinds?.length ? { kinds } : {}),
        }
      } catch {
        return null
      }
    }),
  )
  const native = answers.find((answer) => answer !== null)
  if (native) return native

  /*
   * Nothing speaks AiKi's envelope. That is the ordinary case: `aiki.task/v1`
   * is a protocol AiKi invented and published, and a sweep of the registry
   * found no agent implementing it, while a small number expose real
   * capabilities over MCP. Refusing those was never a safety decision, it was a
   * transport this side had not learned.
   */
  const mcpEndpoints = Array.isArray(services)
    ? [
        ...new Set(
          services
            .filter((service) => String(service?.protocol).toUpperCase() === 'MCP')
            .map((service) => service?.endpoint)
            .filter(
              (endpoint): endpoint is string =>
                typeof endpoint === 'string' && /^https:\/\//i.test(endpoint),
            ),
        ),
      ]
        .sort()
        // Two at most. Discovery is a real protocol handshake against a third
        // party, not a HEAD request, and a registration listing eight of them
        // must not turn one hire into eight conversations.
        .slice(0, 2)
    : []

  for (const endpoint of mcpEndpoints) {
    try {
      const session = await connect(endpoint)
      try {
        const tools = session.tools
          .map((tool) => ({ name: tool.name, description: tool.description.slice(0, 300) }))
          .slice(0, 40)
        if (!tools.length) continue
        return { endpoint, compatible: true, protocol: 'mcp', tools }
      } finally {
        session.close()
      }
    } catch {
      // An endpoint that does not answer the handshake is not reachable this
      // way either. Try the next, then report honestly.
    }
  }

  return {
    endpoint: '',
    compatible: false,
    reason:
      endpoints.length || mcpEndpoints.length
        ? 'This agent does not answer AiKi task delivery or an MCP handshake.'
        : 'This agent has not declared a usable task endpoint.',
  }
}
