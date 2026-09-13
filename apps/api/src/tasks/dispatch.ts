import { createHmac, timingSafeEqual } from 'node:crypto'
import { connectMcp } from '../catalog/mcp.js'
import { guardedFetch } from '../net/guard.js'

/**
 * Asking a hired agent to do the thing it was hired for.
 *
 * Until this existed, hiring an agent took money and paid it out and never
 * asked the agent for anything: DISPATCHED and COMPLETED were states no code
 * could reach. The marketplace could sell something it had never asked anybody
 * to make, and the buyer's only evidence that it had been made was their own
 * decision to pay.
 *
 * There is no standard for this. ERC-8004 gives an agent an identity and a
 * document that declares where it can be reached; it says nothing about handing
 * one a piece of work. So AiKi defines the envelope below and publishes it, and
 * an agent that answers it can be hired for discrete work by anybody.
 *
 * The important design decision is what happens when an agent does not answer,
 * which for most of this registry is what will happen: 2,611 of the agents
 * probed on BSC are static pages. Nothing is retried into oblivion and nothing
 * is hidden. The attempt is recorded on the task, the claim runs out on the
 * same clock a human's would, and the buyer's money goes back. An agent that
 * cannot be reached is a fact about that agent, which is the business AiKi is
 * actually in.
 */

export const DISPATCH_PROTOCOL = 'aiki.task/v1'

export interface DispatchEnvelope {
  protocol: typeof DISPATCH_PROTOCOL
  taskId: string
  agentId: string
  title: string
  brief: string
  /** What the agent's owner is paid on acceptance. */
  pricePoints: number
  /** After this, the work is no longer wanted and the money goes back. */
  deadline: string
  /**
   * Where to send the answer if it cannot be given now.
   *
   * The token is derived from the task, not stored, so there is no table of
   * secrets to leak and no way to accept a delivery for a task that was never
   * dispatched.
   */
  callback: { url: string; token: string }
}

/** A delivery token for one task. Derived, never stored. */
export function deliveryToken(secret: string, taskId: string): string {
  return createHmac('sha256', secret).update(`aiki.task.delivery:${taskId}`).digest('hex')
}

/** Constant-time, because a token check that leaks its answer by timing is not one. */
export function tokenMatches(secret: string, taskId: string, given: string): boolean {
  const expected = Buffer.from(deliveryToken(secret, taskId), 'utf8')
  const offered = Buffer.from(given ?? '', 'utf8')
  if (expected.length !== offered.length) return false
  return timingSafeEqual(expected, offered)
}

export interface DispatchOutcome {
  /** What the agent handed back now, if it did. */
  delivered?: string
  /** Explicit protocol non-delivery only; a transport failure is not a decline. */
  declined?: true
  /** What happened, in a sentence, whether it worked or not. */
  note: string
}

const MAX_DELIVERY_CHARS = 20_000

/**
 * Call the agent, and interpret what comes back generously but not credulously.
 *
 * Three answers are legitimate: here is the work, I have it and will call you
 * back, and no. Everything else is an agent that does not speak this protocol,
 * recorded as exactly that rather than as a failure of ours.
 */
export async function dispatchToAgent(input: {
  endpoint: string
  envelope: DispatchEnvelope
  timeoutMs?: number
}): Promise<DispatchOutcome> {
  let res: Response
  try {
    // The same guarded fetch the prober uses. These are third-party URLs out of
    // a registration document, which is attacker input, and hiring one must not
    // become a way to make AiKi fetch its own internal network.
    res = await guardedFetch(input.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input.envelope),
      signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    })
  } catch (error) {
    return { note: `Could not reach it: ${(error as Error).message ?? 'no response'}.` }
  }

  if (res.status === 202) return { note: 'Accepted the work and will call back.' }

  let parsed: unknown
  try {
    const raw = (await res.text()).slice(0, MAX_DELIVERY_CHARS)
    parsed = JSON.parse(raw)
  } catch {
    /*
     * A page rather than an answer, which is the common case in this registry.
     * Not treated as a delivery: paying for an HTML document somebody's
     * marketing site returned to every POST would be the marketplace paying for
     * nothing and calling it work.
     */
    return { note: 'Answered with something that is not JSON, so it does not speak this protocol.' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { note: 'Answered, but with nothing this protocol recognises as work.' }
  const body = parsed as { result?: unknown; accepted?: unknown; error?: unknown }
  // Never refund a response that contains work, even if another field conflicts.
  if (typeof body.result === 'string' && body.result.trim())
    return res.ok
      ? { delivered: body.result.slice(0, MAX_DELIVERY_CHARS), note: 'Answered straight away.' }
      : { note: `Answered ${res.status} with possible work; delivery remains unconfirmed.` }
  if (body.accepted === true) return { note: 'Accepted the work and will call back.' }
  const explicitRefusal = body.accepted === false
  const error = typeof body.error === 'string' ? body.error.trim().slice(0, 200) : ''
  // A bare auth/rate-limit/conflict/server error may follow work already accepted.
  // Only accepted:false can disambiguate a retryable 4xx protocol reply.
  const ordinaryDecline = res.ok || [400, 404, 405, 410, 413, 415, 422].includes(res.status)
  const explicitClientDecline = res.status >= 400 && res.status < 500 && explicitRefusal
  if ((ordinaryDecline && (explicitRefusal || error)) || explicitClientDecline)
    return {
      declined: true,
      note: `Declined it: ${error || 'The agent did not accept this task.'}`,
    }
  if (!res.ok) return { note: `Answered ${res.status}; whether it accepted work is unconfirmed.` }
  return { note: 'Answered, but with nothing this protocol recognises as work.' }
}

/**
 * Hiring an agent that speaks MCP instead of AiKi's own envelope.
 *
 * `aiki.task/v1` is a protocol AiKi invented and published, and the honest
 * result of a sweep is that zero agents on the registry implement it. Meanwhile
 * a small number do expose real capabilities over MCP, and the task board could
 * not reach any of them. That is not a safety boundary, it is a transport this
 * side never learned to speak.
 *
 * Worth being clear about what this does and does not risk. Calling a
 * stranger's tool over HTTP grants them nothing: no key, no session, no mandate,
 * no access to the buyer's wallet. The money at stake is escrowed points, and
 * the buyer still reviews before any of it is released. That is a materially
 * smaller exposure than the read connector, which runs against the signed-in
 * wallet's own address, and it is why this does not need the same per-tool
 * allowlist.
 *
 * What it does need is to stay uncredulous about the answer, which is the same
 * discipline the HTTP path already has: a response is work only when it is
 * plainly work.
 */

/** MCP's own failure flag. A tool that says it failed has not delivered. */
function mcpText(result: Record<string, unknown>): { text: string; isError: boolean } {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .map((part) => {
      const block = part as { type?: unknown; text?: unknown } | null
      return block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
  return { text: text.slice(0, MAX_DELIVERY_CHARS), isError: result.isError === true }
}

export interface McpDispatchInput {
  endpoint: string
  tool: string
  /**
   * Already complete, including any idempotency field the provider's schema
   * declares. Built by the caller, because the caller is the side that knows
   * what it has already recorded and must not send twice.
   */
  arguments: Record<string, unknown>
  connect?: typeof connectMcp
}

export async function dispatchOverMcp(input: McpDispatchInput): Promise<DispatchOutcome> {
  let session: Awaited<ReturnType<typeof connectMcp>>
  try {
    session = await (input.connect ?? connectMcp)(input.endpoint)
  } catch (error) {
    return { note: `Could not reach it over MCP: ${(error as Error).message ?? 'no response'}.` }
  }

  try {
    /*
     * The tool has to be one the provider is advertising right now. A name that
     * was valid when the task was created and is gone at dispatch time is a
     * different agent than the one that was hired, and calling it anyway would
     * be guessing with somebody's money.
     */
    if (!session.tools.some((tool) => tool.name === input.tool))
      return { note: `It no longer offers a tool called ${input.tool}.` }

    let result: Record<string, unknown>
    try {
      result = await session.call(input.tool, input.arguments as never)
    } catch (error) {
      return { note: `Called it and the call failed: ${(error as Error).message ?? 'no answer'}.` }
    }

    const { text, isError } = mcpText(result)
    /*
     * A structured refusal is a refusal. These providers answer an out-of-scope
     * request with a well-formed explanation rather than an exception, and
     * treating that as delivered work is the marketplace paying full price for
     * the word no.
     */
    if (isError)
      return {
        declined: true,
        note: `Declined it: ${text || 'The tool reported an error.'}`,
      }
    if (!text) return { note: 'Answered, but with nothing this protocol recognises as work.' }
    return { delivered: text, note: `Answered straight away over MCP, using ${input.tool}.` }
  } finally {
    session.close()
  }
}

/**
 * Hiring an agent that speaks A2A.
 *
 * Seventy-two of the endpoints that answer anything on this chain answer this,
 * which makes it the largest single group, larger than MCP. The shape is a card
 * describing the agent and a JSON-RPC url to send work to.
 *
 * Two things learned by probing rather than by reading the spec. The registered
 * endpoint is usually the CARD itself at a per-agent path rather than an origin
 * with a well-known file, so the card is fetched from where the registration
 * points and the well-known paths are only a fallback. And the largest A2A
 * publisher on this chain registered the literal unsubstituted string
 * `{agentId}` across twelve hundred identities, so a placeholder is refused
 * rather than fetched.
 */

/** Every shape an A2A answer can carry text in: a message, a task, an artifact. */
function a2aText(result: unknown): string {
  const parts: string[] = []
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6) return
    const record = node as Record<string, unknown>
    if (Array.isArray(record.parts))
      for (const part of record.parts) {
        const piece = part as { kind?: unknown; type?: unknown; text?: unknown } | null
        if (
          piece &&
          typeof piece.text === 'string' &&
          (piece.kind ?? piece.type ?? 'text') === 'text'
        )
          parts.push(piece.text)
      }
    for (const key of ['status', 'message', 'result']) walk(record[key], depth + 1)
    if (Array.isArray(record.artifacts))
      for (const artifact of record.artifacts.slice(0, 20)) walk(artifact, depth + 1)
  }
  walk(result, 0)
  return parts.join('\n').trim().slice(0, MAX_DELIVERY_CHARS)
}

/** The task state A2A reports, when the answer is a task rather than a message. */
function a2aState(result: unknown): string {
  const record = result as { kind?: unknown; status?: { state?: unknown } } | null
  if (!record || typeof record !== 'object') return ''
  const state = record.status?.state
  return typeof state === 'string' ? state : ''
}

export interface A2ADispatchInput {
  /** The JSON-RPC url from the card, never the card url itself. */
  url: string
  title: string
  brief: string
  /** Stable per task. Doubles as the A2A messageId, which the protocol requires. */
  intent: string
  /** A skill id from the card, when the buyer named one. */
  skill?: string
  /**
   * What the buyer filled in, sent as structured data rather than described.
   *
   * The reason this exists: a real hire of a real agent came back "the task
   * does not state lower bound, upper bound, capital, stop price, fee per
   * trade", and resending with every one of those written into the prose got
   * the identical refusal. A parameterised agent reads a data part. It does not
   * parse English, and nothing in the protocol says it should.
   */
  agentInput?: Record<string, unknown>
  fetcher?: typeof guardedFetch
}

export async function dispatchOverA2A(input: A2ADispatchInput): Promise<DispatchOutcome> {
  const message = {
    role: 'user',
    kind: 'message',
    messageId: input.intent,
    parts: [
      { kind: 'text', text: `${input.title}\n\n${input.brief}` },
      /*
       * One data part carrying both, with the skill written last so buyer input
       * cannot overwrite which capability was bought and paid for.
       */
      ...(input.skill || input.agentInput
        ? [
            {
              kind: 'data',
              data: {
                ...input.agentInput,
                ...(input.skill ? { skill: input.skill } : {}),
              },
            },
          ]
        : []),
    ],
  }

  let res: Response
  try {
    res = await (input.fetcher ?? guardedFetch)(input.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: input.intent,
        method: 'message/send',
        params: { message },
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { note: `Could not reach it over A2A: ${(error as Error).message ?? 'no response'}.` }
  }

  let body: unknown
  try {
    body = JSON.parse((await res.text()).slice(0, MAX_DELIVERY_CHARS * 2))
  } catch {
    return { note: 'Answered with something that is not JSON, so it does not speak A2A.' }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { note: 'Answered, but with nothing this protocol recognises as work.' }

  const envelope = body as { error?: { message?: unknown }; result?: unknown }
  /*
   * A JSON-RPC error is the agent declining in the only way this protocol gives
   * it. Treating that as delivered work is the marketplace paying full price
   * for an explanation of why the job will not be done.
   */
  if (envelope.error) {
    const reason =
      typeof envelope.error.message === 'string' ? envelope.error.message.slice(0, 200) : ''
    return { declined: true, note: `Declined it: ${reason || 'The agent returned an error.'}` }
  }

  /*
   * A task carries its own verdict, and the protocol names the states that are
   * not finished work: `input-required` and `auth-required` are the agent
   * asking for something back, `failed` and `rejected` are it saying no, and
   * `canceled` is it stopping. Reading the text out of any of those and
   * recording a delivery is the marketplace paying full price for the sentence
   * "you did not tell me enough", which is exactly what a real hire returned.
   *
   * Only a task has a state. A bare message has none, and an absent state is
   * not a refusal, so it is still read as an answer.
   */
  const state = a2aState(envelope.result)
  if (state && state !== 'completed') {
    const said = a2aText(envelope.result)
    return {
      declined: true,
      note: `Declined it: ${said ? said.slice(0, 200) : `the agent reported ${state}.`}`,
    }
  }

  const text = a2aText(envelope.result)
  if (!text) return { note: 'Answered, but with nothing this protocol recognises as work.' }
  return { delivered: text, note: 'Answered straight away over A2A.' }
}
