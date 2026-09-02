import { createHmac, timingSafeEqual } from 'node:crypto'
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
  if (!res.ok) return { note: `Answered ${res.status} rather than taking the work.` }

  const raw = (await res.text()).slice(0, MAX_DELIVERY_CHARS)
  let parsed: unknown
  try {
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

  const body = parsed as { result?: unknown; accepted?: unknown; error?: unknown }
  if (typeof body.error === 'string') return { note: `Declined it: ${body.error.slice(0, 200)}` }
  if (body.accepted === true) return { note: 'Accepted the work and will call back.' }
  if (typeof body.result === 'string' && body.result.trim())
    return {
      delivered: body.result.slice(0, MAX_DELIVERY_CHARS),
      note: 'Answered straight away.',
    }
  return { note: 'Answered, but with nothing this protocol recognises as work.' }
}
