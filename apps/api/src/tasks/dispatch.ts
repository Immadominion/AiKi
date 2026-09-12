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
