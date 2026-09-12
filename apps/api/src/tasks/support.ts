import { connectMcp } from '../catalog/mcp.js'
import { guardedFetch } from '../net/guard.js'
import { DISPATCH_PROTOCOL } from './dispatch.js'
import { isTaskKind } from './kinds.js'

/** What a hired agent is reached over. AiKi's own envelope, or plain MCP. */
export type TaskTransport = typeof DISPATCH_PROTOCOL | 'mcp' | 'a2a'

export interface AgentTaskContact {
  owner: string
  endpoint: string
  live: boolean
  /** Production always sets this. Optional only for existing injected test contacts. */
  compatible?: boolean
  reason?: string
  protocol?: string
  /**
   * Whether the endpoint has proven it belongs to this registered identity.
   *
   * False means it answers its protocol and has not published the reciprocal
   * proof, which most of this ecosystem has not. It ranks a listing and is said
   * out loud before anybody pays; it does not remove the listing.
   */
  identityProven?: boolean
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

/**
 * The agent card an A2A registration points at, and the url to actually call.
 *
 * Probing the registry taught two things the specification does not. The
 * registered endpoint is usually the CARD, at a per-agent path, so the origin's
 * well-known files are a fallback rather than the first try. And the largest
 * A2A publisher here registered the literal unsubstituted string `{agentId}`
 * across twelve hundred identities, which is a template nobody filled in; every
 * one of those resolves to nothing, so a placeholder is refused before it
 * becomes a request.
 */
async function resolveA2ACard(
  endpoint: string,
  read: typeof guardedFetch,
): Promise<{ url: string; skills: { name: string; description: string }[] } | null> {
  if (/[{}]/.test(endpoint)) return null
  let origin: string
  try {
    origin = new URL(endpoint).origin
  } catch {
    return null
  }
  const candidates = [
    endpoint,
    `${origin}/.well-known/agent-card.json`,
    // Some publishers serve only this older name, so both are tried.
    `${origin}/.well-known/agent.json`,
  ]
  for (const candidate of [...new Set(candidates)]) {
    try {
      const card = await capability(
        await read(candidate, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(6_000),
        }),
      )
      const url = typeof card?.url === 'string' ? card.url : ''
      if (!url || !/^https:\/\//i.test(url) || /[{}]/.test(url)) continue
      const skills = Array.isArray(card?.skills)
        ? card.skills
            .map((skill) => {
              const entry = skill as { id?: unknown; name?: unknown; description?: unknown } | null
              const name =
                typeof entry?.id === 'string'
                  ? entry.id
                  : typeof entry?.name === 'string'
                    ? entry.name
                    : ''
              return {
                name,
                description:
                  typeof entry?.description === 'string' ? entry.description.slice(0, 300) : '',
              }
            })
            .filter((skill) => skill.name)
            .slice(0, 40)
        : []
      // A card with no skills describes nothing that can be bought.
      if (!skills.length) continue
      return { url, skills }
    } catch {
      // Try the next shape.
    }
  }
  return null
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
                typeof endpoint === 'string' &&
                /^https?:\/\//i.test(endpoint) &&
                // An unsubstituted template is not an address. The largest
                // publisher on this chain registered the literal string
                // `{agentId}` across twelve hundred identities, and fetching
                // one is a guaranteed miss on somebody else's server.
                !/[{}]/.test(endpoint),
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

  /*
   * A2A is the largest group that answers anything on this chain, larger than
   * MCP, so it is tried rather than written off.
   */
  const a2aEndpoints = Array.isArray(services)
    ? [
        ...new Set(
          services
            .filter((service) => String(service?.protocol).toUpperCase() === 'A2A')
            .map((service) => service?.endpoint)
            .filter(
              (endpoint): endpoint is string =>
                typeof endpoint === 'string' && /^https:\/\//i.test(endpoint),
            ),
        ),
      ]
        .sort()
        .slice(0, 2)
    : []

  for (const endpoint of a2aEndpoints) {
    const card = await resolveA2ACard(endpoint, read)
    if (card) return { endpoint: card.url, compatible: true, protocol: 'a2a', tools: card.skills }
  }

  return {
    endpoint: '',
    compatible: false,
    reason:
      endpoints.length || mcpEndpoints.length || a2aEndpoints.length
        ? 'This agent does not answer AiKi task delivery, an MCP handshake or an A2A card.'
        : 'This agent has not declared a usable task endpoint.',
  }
}
