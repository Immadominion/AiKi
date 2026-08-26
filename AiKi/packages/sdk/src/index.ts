/**
 * The AiKi agent SDK: what a third party builds against.
 *
 * AiKi probes every agent in the ERC-8004 registry and publishes what it finds.
 * Of 1,143 agents probed, eleven answered like agents at all. The rest register
 * a name and publish nothing to call, or return the same bytes whatever you ask
 * them, or point at localhost.
 *
 * This library exists so that clearing that bar is the easy path. It does not
 * help an agent look live; it makes an agent that answers honestly the default,
 * and an agent that cannot be told apart from a static page structurally
 * difficult to write. Everything the prober checks is documented on the piece of
 * this file that satisfies it, so a developer can see exactly what is being
 * asked of them and why.
 */

export interface AgentSkill {
  /** Stable machine name, e.g. "assess_health_factor". */
  id: string
  name: string
  description: string
  /** ERC-8004 category, so AiKi can place the agent in the right comparison. */
  category?: string
}

export interface AgentDefinition<Result = unknown> {
  /** The ERC-721 token id from the registry this agent is registered in. */
  agentId: string
  chainId: number
  /** The IdentityRegistry address the agentId belongs to. */
  registry: string
  name: string
  description: string
  skills: AgentSkill[]
  /**
   * The work. Called only for this agent's own id; the router answers for any
   * other id before this runs, so a handler cannot accidentally serve a
   * one-size-fits-all response.
   */
  assess(input: { skillId: string; params: Record<string, string> }): Promise<Result> | Result
}

export interface AgentResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const json = (status: number, value: unknown): AgentResponse => ({
  status,
  // A machine-readable content type is required, not decorative: an endpoint
  // answering 200 with text/html is indistinguishable from a marketing page and
  // AiKi grades it DEGRADED for exactly that reason.
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(value),
})

/** `eip155:56:0xabc…` — how a registry is named in a reciprocal proof. */
export const caip10Registry = (chainId: number, registry: string) =>
  `eip155:${chainId}:${registry.toLowerCase()}`

/**
 * The reciprocal proof, served at /.well-known/agent-registration.json.
 *
 * The registry records a URL; anyone can register any URL, including yours. This
 * file is the other half: the domain naming the agent ids it actually speaks
 * for. Roughly 0.04% of the registry serves one, which is why AiKi treats a
 * missing proof as a real gap rather than a formality.
 */
export function registrationDocument(agents: AgentDefinition[]) {
  return {
    registrations: agents.map((a) => ({
      agentId: a.agentId,
      agentRegistry: caip10Registry(a.chainId, a.registry),
    })),
  }
}

/** The card served for this agent's own id. */
export function agentCard(agent: AgentDefinition) {
  return {
    agentId: agent.agentId,
    chainId: agent.chainId,
    registry: agent.registry,
    name: agent.name,
    description: agent.description,
    skills: agent.skills,
    protocolVersion: 'aiki-agent/1',
  }
}

/**
 * Routes one request.
 *
 * The identity check is the point of this function. AiKi probes each endpoint
 * three times, with the real id, a nonsense id and a non-numeric id, and any
 * endpoint returning byte-identical responses to all three is classified
 * IMPOSTOR_STATIC. A third of the BSC registry fails exactly here. Answering
 * "that is not me" for an id you do not own is therefore not an error path, it
 * is the thing that distinguishes an agent from a web page, so the router does
 * it for you and the response names the id it was asked about.
 */
export async function handle(
  agents: AgentDefinition[],
  request: { method: string; url: string },
): Promise<AgentResponse> {
  let url: URL
  try {
    url = new URL(request.url, 'http://agent.local')
  } catch {
    return json(400, { error: 'Unparseable request URL.' })
  }

  if (url.pathname === '/.well-known/agent-registration.json')
    return json(200, registrationDocument(agents))

  if (url.pathname === '/agents') return json(200, { agents: agents.map((a) => a.agentId) })

  const match = /^\/agents\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname)
  if (!match) return json(404, { error: 'No such route.', path: url.pathname })

  const [, rawId, skillId] = match
  const agentId = decodeURIComponent(rawId ?? '')
  const agent = agents.find((a) => a.agentId === agentId)

  if (!agent)
    return json(404, {
      error: 'This service does not speak for that agent id.',
      // Naming the id is what makes this response differ per request, which is
      // what proves the endpoint is agent-specific rather than a static page.
      requestedAgentId: agentId,
      servedAgentIds: agents.map((a) => a.agentId),
    })

  if (!skillId) return json(200, agentCard(agent))

  if (!agent.skills.some((s) => s.id === skillId))
    return json(404, {
      error: 'This agent has no such skill.',
      agentId,
      requestedSkill: skillId,
      skills: agent.skills.map((s) => s.id),
    })

  if (request.method !== 'GET' && request.method !== 'POST')
    return json(405, { error: 'Use GET or POST.', agentId })

  try {
    const params = Object.fromEntries(url.searchParams)
    const result = await agent.assess({ skillId, params })
    return json(200, { agentId, skillId, result, observedAt: new Date().toISOString() })
  } catch (error) {
    // A failed assessment is reported as a failed assessment. Returning a
    // cheerful 200 would make the endpoint look healthier than it is, and AiKi
    // is measuring precisely that difference.
    return json(502, {
      error: 'The assessment failed.',
      agentId,
      skillId,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * A ready-made Node server.
 *
 * Deliberately dependency-free: an agent should not have to adopt a web
 * framework to be listed, and `handle` is available on its own for anyone who
 * already has one.
 */
export async function serve(agents: AgentDefinition[], options: { port: number; host?: string }) {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    void handle(agents, { method: req.method ?? 'GET', url: req.url ?? '/' }).then((out) => {
      res.writeHead(out.status, out.headers)
      res.end(out.body)
    })
  })
  await new Promise<void>((resolve) =>
    server.listen(options.port, options.host ?? '0.0.0.0', resolve),
  )
  return server
}

/**
 * The service entry to publish in your ERC-8004 registration file.
 *
 * It must contain the agent id, because AiKi proves agent-specificity by varying
 * that id and comparing the responses. A URL with nothing to vary cannot be
 * shown to be agent-specific, and AiKi reports it as DEGRADED rather than
 * assuming the best.
 */
export function serviceEndpoint(baseUrl: string, agent: AgentDefinition) {
  return {
    name: 'aiki-agent',
    type: 'http',
    url: `${baseUrl.replace(/\/$/, '')}/agents/${agent.agentId}`,
  }
}
