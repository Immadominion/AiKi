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
  tools?: AgentCapability[]
}

/**
 * One thing an agent sells, and what it needs before it can do it.
 *
 * The last field is the one that was missing, and its absence was not cosmetic:
 * a buyer could find a parameterised agent, pay it, and get back "you did not
 * tell me the bounds, the capital or the stop". AiKi knew the shape all along
 * for MCP, threw it away at discovery, and then sent prose.
 *
 * `inputSchema` is the tool's own JSON Schema, relayed and never invented.
 * `examples` is the nearest thing A2A has: its cards carry no schema, so a
 * skill's own examples are the only machine-readable statement of what a call
 * looks like.
 */
export interface AgentCapability {
  name: string
  description: string
  inputSchema?: unknown
  examples?: string[]
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

/** An A2A agent card, or null. Shared so one fetched document is judged once. */
function asAgentCard(
  card: Record<string, unknown> | null,
): { url: string; skills: AgentCapability[] } | null {
  const url = typeof card?.url === 'string' ? card.url : ''
  if (!url || !/^https:\/\//i.test(url) || /[{}]/.test(url)) return null
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
          /*
           * A2A 0.3.0 gives a skill no input schema, so examples are the only
           * thing on a card that says what a call actually looks like. Relayed
           * as the provider wrote them, capped, and never turned into a schema
           * AiKi made up.
           */
          const examples = Array.isArray((entry as { examples?: unknown } | null)?.examples)
            ? (entry as { examples: unknown[] }).examples
                .filter((example): example is string => typeof example === 'string')
                .slice(0, 4)
                .map((example) => example.slice(0, 400))
            : []
          return {
            name,
            description:
              typeof entry?.description === 'string' ? entry.description.slice(0, 300) : '',
            ...(examples.length ? { examples } : {}),
          }
        })
        .filter((skill) => skill.name)
        .slice(0, 40)
    : []
  // A card with no skills describes nothing that can be bought.
  return skills.length ? { url, skills } : null
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
      const card = asAgentCard(
        await capability(
          await read(candidate, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(6_000),
          }),
        ),
      )
      if (card) return card
    } catch {
      // Try the next shape.
    }
  }
  return null
}

/**
 * Which protocol a declared service speaks.
 *
 * ERC-8004 registration files name a service with `name`, and the resolver that
 * stores them keeps exactly `{name, endpoint, version?, transport?}`. Reading a
 * `protocol` key instead found nothing on every real registration, so MCP and
 * A2A discovery never ran against a single agent on the chain. Both spellings
 * are read now, plus `type`, because the catalog's own projection uses that.
 */
function serviceProtocol(service: unknown): string {
  const entry = service as { name?: unknown; protocol?: unknown; type?: unknown } | null
  for (const value of [entry?.protocol, entry?.name, entry?.type])
    if (typeof value === 'string' && value.trim()) return value.trim().toUpperCase()
  return ''
}

/**
 * Endpoints worth opening a handshake against for one protocol.
 *
 * A registration that labels its services is taken at its word. One that labels
 * nothing, which is common, still gets tried rather than written off, because a
 * missing label is not evidence of a missing capability. Either way the count is
 * capped: discovery is a real conversation with a third party, not a HEAD
 * request, and one hire must not become eight of them.
 */
function discoveryEndpoints(services: unknown, protocol: 'MCP' | 'A2A'): string[] {
  if (!Array.isArray(services)) return []
  const usable = services.filter(
    (service) =>
      typeof service?.endpoint === 'string' &&
      /^https:\/\//i.test(service.endpoint) &&
      !/[{}]/.test(service.endpoint),
  )
  const labelled = usable.filter((service) => serviceProtocol(service) === protocol)
  const chosen = labelled.length
    ? labelled
    : usable.filter((service) => {
        const label = serviceProtocol(service)
        // An endpoint labelled as another protocol is not a candidate; an
        // unlabelled one is.
        return label === '' || label === 'SERVICE'
      })
  return [...new Set(chosen.map((service) => service.endpoint as string))].sort().slice(0, 2)
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
        // The body is kept whatever it turns out to be. This same GET is the
        // only look most endpoints get, and fetching a third party twice to ask
        // two questions about one document is waste somebody else pays for.
        if (metadata?.taskProtocol !== DISPATCH_PROTOCOL) return { endpoint, metadata }
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
  const native = answers.find((answer) => answer !== null && 'compatible' in answer)
  if (native) return native

  /*
   * An agent card, read out of the document already fetched above. Most A2A
   * registrations point straight at their card, so this costs nothing beyond
   * the look every endpoint already gets.
   */
  for (const answer of answers) {
    if (!answer || 'compatible' in answer) continue
    const card = asAgentCard(answer.metadata)
    if (card) return { endpoint: card.url, compatible: true, protocol: 'a2a', tools: card.skills }
  }

  /*
   * Nothing speaks AiKi's envelope. That is the ordinary case: `aiki.task/v1`
   * is a protocol AiKi invented and published, and a sweep of the registry
   * found no agent implementing it, while a small number expose real
   * capabilities over MCP. Refusing those was never a safety decision, it was a
   * transport this side had not learned.
   */
  const mcpEndpoints = discoveryEndpoints(services, 'MCP')

  for (const endpoint of mcpEndpoints) {
    try {
      const session = await connect(endpoint)
      try {
        const tools = session.tools
          .map((tool) => ({
            name: tool.name,
            description: tool.description.slice(0, 300),
            /*
             * The tool's own schema, relayed. AiKi already had this at every
             * handshake and dropped it here, so a buyer could be sold a
             * parameterised tool with no way to learn what it takes, and the
             * dispatcher then sent prose. Capped the way the catalogue caps it:
             * a schema too big to read is not a schema anybody can fill in.
             */
            ...(tool.inputSchema && JSON.stringify(tool.inputSchema).length <= 16_384
              ? { inputSchema: tool.inputSchema }
              : {}),
          }))
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
  /*
   * Only a service that said A2A gets the well-known paths chased on its
   * origin. An unlabelled endpoint has already been read once above and judged
   * as a card there, so guessing two more URLs on somebody's domain would be
   * three requests to answer a question one already answered.
   */
  const a2aEndpoints = Array.isArray(services)
    ? [
        ...new Set(
          services
            .filter(
              (service) =>
                serviceProtocol(service) === 'A2A' &&
                typeof service?.endpoint === 'string' &&
                /^https:\/\//i.test(service.endpoint) &&
                !/[{}]/.test(service.endpoint),
            )
            .map((service) => service.endpoint as string),
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
