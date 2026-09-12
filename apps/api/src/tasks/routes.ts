import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireSession } from '../auth/guard.js'
import { settlementForPoints } from '../credits/pricing.js'
import {
  type CreditStore,
  ESCROW_ACCOUNT,
  InsufficientBalance,
  PostgresCreditStore,
} from '../credits/store.js'
import { ClientError } from '../http/errors.js'
import type { JobService } from '../jobs/service.js'
import { hashCanonicalJson } from '../marketplace/canonical-json.js'
import type { JsonValue } from '../marketplace/model.js'
import { PLATFORM_FEE_BPS, priceJob, SETTLEMENT } from '../settlement/pricing.js'
import {
  DISPATCH_PROTOCOL,
  deliveryToken,
  dispatchOverMcp,
  dispatchToAgent,
  tokenMatches,
} from './dispatch.js'
import { isTaskKind, TASK_KINDS, type TaskKind } from './kinds.js'
import type { PostgresSellerStore } from './sellers.js'
import type { TaskRecord, TaskStore } from './store.js'
import type { AgentTaskContact } from './support.js'

/**
 * Work posted for somebody else to do, and the money that backs it.
 *
 * The marketplace could only express one shape of trade: pick a listed agent,
 * pay its published price. That cannot describe an agent hiring a person,
 * because the person has no listing, no URL that answers a probe and no
 * ERC-8004 identity, and because the thing being bought does not exist until
 * somebody writes it down.
 *
 * So the seller is unknown when the money is committed. The poster funds escrow
 * first, and the work becomes visible only once the money is behind it: nobody
 * is ever asked to start on a promise. The ledger is the one hires settle on,
 * because escrow, fees and refunds do not care whether the payee is a bot.
 *
 * Three properties are load-bearing, and all three exist because this exact
 * primitive has measured abuse attached to it (arXiv 2602.19514):
 *
 *   The money is locked before the work is visible, and the poster cannot pull
 *   it once somebody has claimed. Reading a submission and then withdrawing is
 *   theft with extra steps.
 *
 *   An agent posting under a mandate spends against that mandate's caps. An
 *   agent with a budget for on-chain actions should not have an unlimited one
 *   for human labour.
 *
 *   What can be asked for is an allowlist. There is no kind here under which
 *   "make me forty accounts" can be written, so it has no shape in the system
 *   rather than a shape somebody has to detect.
 */

/** Cheap upper bounds, so a post cannot be a novel or a denial of service. */
const MAX_TITLE = 120
const MAX_BRIEF = 2_000
const MAX_SUBMISSION = 20_000
/** A tenth of a cent. Below this the fee rounds to nothing and so does the work. */
const MIN_PRICE_POINTS = 10

const fundingTransfer = (task: TaskRecord) => ({
  from: task.poster,
  to: ESCROW_ACCOUNT,
  points: task.totalPoints,
  reason: 'task_funding',
  reference: `task:${task.id}:funding`,
})

const fundingUnconfirmed = (reply: FastifyReply, taskId: string) =>
  reply.code(503).send({
    error: {
      code: 'TASK_FUNDING_UNCONFIRMED',
      message:
        'AiKi cannot confirm this task payment yet. No new work was sent. Keep this task and check Work before trying another hire.',
      taskId,
      workUrl: '/work',
      retryable: false,
    },
  })

export function registerTaskRoutes(
  app: FastifyInstance,
  input: {
    tasks: TaskStore
    credits?: CreditStore
    jobs: JobService
    settlementTreasury?: string
    /**
     * Who owns an agent and where it can be reached, out of what it registered.
     *
     * Injected because this file has no evidence store and should not grow one.
     * Absent means hiring a named agent is not offered, rather than offered and
     * then failing at the moment somebody's money is involved.
     */
    agentContact?: (agentId: string) => Promise<AgentTaskContact | null>
    /** Where an agent sends work back to. This API, from outside. */
    publicUrl?: string
    /** Signs the delivery tokens. Derived per task, never stored. */
    deliverySecret?: string
    /** People who can be found and hired. Absent means listings are not offered. */
    sellers?: PostgresSellerStore
  },
) {
  const text = (value: unknown, max: number) =>
    typeof value === 'string' ? value.trim().slice(0, max) : ''
  const activeRequests = new WeakMap<FastifyRequest, string>()
  const recoverFundingResponse = async (owner: string, statusCode: number, body: unknown) => {
    // Only the completed, owner/key/body-bound funding failure is recoverable.
    // An in-progress request or uncertain provider call must never be restarted.
    if (statusCode !== 503 || !body || typeof body !== 'object' || !('error' in body)) return null
    const error = body.error
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'TASK_FUNDING_UNCONFIRMED' ||
      !('taskId' in error) ||
      typeof error.taskId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(error.taskId) ||
      !input.credits?.transferRecorded
    )
      return null
    try {
      const task = await input.tasks.get(error.taskId)
      if (
        !task ||
        task.poster.toLowerCase() !== owner.toLowerCase() ||
        !(await input.credits.transferRecorded(fundingTransfer(task)))
      )
        return null
      const terminal = task.status === 'SETTLED' || task.status === 'CANCELLED'
      const next =
        task.status === 'OPEN'
          ? 'You can cancel unclaimed work in Work.'
          : task.status === 'CLAIMED'
            ? 'If no work is delivered, you can request cancellation in Work after the original claim deadline.'
            : 'Check its current delivery and payment status in Work.'
      return {
        ...task,
        outlay: task.outlay.toString(),
        // Original funding is not a new charge or proof of a terminal payout.
        // Preserve Hire's response shape without claiming a terminal refund.
        originalFundingConfirmed: true,
        heldPoints: terminal ? 0 : task.totalPoints,
        workUrl: `/work?task=${task.id}`,
        recoveryNote: `The original task funding is confirmed. Current task status: ${task.status}. No new work was sent by this retry. ${next}`,
      }
    } catch {
      // Keep the saved failure when either exact read is still unavailable.
      return null
    }
  }
  const finalizePayment = async (
    task: TaskRecord,
    actor: string,
    action: 'accept' | 'release' | 'cancel',
    reply: FastifyReply,
  ) => {
    if (!(await requireFunding(task, reply))) return null
    if (!(input.credits instanceof PostgresCreditStore) || !input.tasks.finalizePayment) {
      reply.code(503).send({
        error: {
          code: 'SETTLEMENT_UNAVAILABLE',
          message:
            'This deployment cannot finalize task payments atomically. No task payment was changed.',
          retryable: false,
        },
      })
      return null
    }
    try {
      const result = await input.tasks.finalizePayment({
        taskId: task.id,
        actor,
        action,
        ...(input.settlementTreasury ? { treasury: input.settlementTreasury } : {}),
      })
      if (result) return result
      reply.code(409).send({
        error: {
          code:
            action === 'cancel'
              ? 'TASK_NOT_CANCELLABLE'
              : action === 'release'
                ? 'NOT_RELEASABLE'
                : 'NOTHING_TO_ACCEPT',
          message:
            'This task cannot make that payment transition. Refresh Work to see its current state.',
          retryable: false,
        },
      })
    } catch {
      reply.code(503).send({
        error: {
          code: 'TASK_PAYMENT_UNCONFIRMED',
          message:
            'The task payment could not be confirmed. Keep this task and retry the same action; do not fund another task. Existing terminal records may need operator review.',
          retryable: true,
        },
      })
    }
    return null
  }
  const requireFunding = async (task: TaskRecord, reply: FastifyReply) => {
    // Existing injected test stores may omit the read. Both production ledger
    // stores implement it, so shared escrow is never proof of this task's funds.
    if (!input.credits?.transferRecorded) return true
    try {
      if (await input.credits.transferRecorded(fundingTransfer(task))) return true
    } catch {
      // An unavailable ledger is uncertainty, not permission to pay or refund.
    }
    fundingUnconfirmed(reply, task.id)
    return false
  }

  app.get<{ Params: { id: string } }>('/v1/agents/:id/task-support', async (request) => {
    const base = { minimumPricePoints: MIN_PRICE_POINTS, feeBasisPoints: PLATFORM_FEE_BPS }
    if (!input.credits || !input.agentContact)
      return {
        ...base,
        available: false,
        reason: 'Task delivery is not configured on this deployment.',
      }
    const contact = await input.agentContact(request.params.id)
    if (!contact?.owner)
      return { ...base, available: false, reason: 'This agent has no recorded owner to pay.' }
    if (!contact.live)
      return {
        ...base,
        available: false,
        reason: contact.reason ?? 'This agent is not currently available for hire.',
      }
    if (!contact.endpoint || contact.compatible === false)
      return {
        ...base,
        available: false,
        reason: contact.reason ?? 'This agent does not support AiKi task delivery.',
      }
    // Only the native envelope needs somewhere to call back to.
    if (contact.protocol !== 'mcp' && (!input.publicUrl || !input.deliverySecret))
      return {
        ...base,
        available: false,
        reason: 'Task delivery is not configured on this deployment.',
      }
    return {
      ...base,
      available: true,
      protocol: contact.protocol === 'mcp' ? 'mcp' : DISPATCH_PROTOCOL,
      ...(contact.inputHint ? { inputHint: contact.inputHint } : {}),
      ...(contact.kinds?.length ? { kinds: contact.kinds } : {}),
      /*
       * What an MCP agent is advertising right now, so a buyer can name the
       * capability they are paying for. Read live rather than remembered: a
       * tool list from last week describes an agent that may no longer exist.
       */
      ...(contact.protocol === 'mcp' && contact.tools?.length
        ? { tools: contact.tools, toolRequired: true }
        : {}),
    }
  })

  /**
   * The board.
   *
   * Public, like the registry. Somebody deciding whether this is worth signing
   * in for should be able to see whether there is any work on it, and an agent
   * looking for something to do should not need an account to look.
   */
  app.get('/v1/tasks', async () => {
    const open = await input.tasks.open(50)
    return {
      kinds: TASK_KINDS,
      tasks: open.map((t) => ({ ...t, outlay: t.outlay.toString() })),
    }
  })

  app.get('/v1/tasks/mine', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const mine = await input.tasks.mine(session.address)
    return { tasks: mine.map((t) => ({ ...t, outlay: t.outlay.toString() })) }
  })

  app.get<{ Params: { id: string } }>('/v1/tasks/:id', async (request, reply) => {
    const task = await input.tasks.get(request.params.id)
    const publiclyOpen =
      task &&
      !task.directHire &&
      !task.assignedAgentId &&
      (task.status === 'OPEN' ||
        (task.status === 'CLAIMED' &&
          task.claimExpiresAt &&
          Date.parse(task.claimExpiresAt) < Date.now()))
    const address = request.session?.address.toLowerCase()
    const participant =
      task &&
      address &&
      (task.poster.toLowerCase() === address || task.claimedBy?.toLowerCase() === address)
    if (!task || (!publiclyOpen && !participant))
      return reply.code(404).send({
        error: { code: 'TASK_NOT_FOUND', message: 'No such task.', retryable: false },
      })
    // For private work, also reject a stale cookie after another wallet was selected.
    if (!publiclyOpen && !requireSession(request, reply)) return reply
    return { ...task, outlay: task.outlay.toString() }
  })

  /**
   * Post work, and pay for it up front.
   *
   * The money moves before the task is visible. A board of unfunded requests is
   * a board of things that might not pay, and the first person who does the work
   * and is not paid tells everybody else.
   */
  app.post<{
    Body: {
      title?: string
      brief?: string
      kind?: string
      pricePoints?: number
      workHours?: number
      authorizationId?: string
      /** Hire this one agent instead of opening the work to whoever claims it. */
      assignAgentId?: string
      /**
       * Which capability of an MCP agent to call, chosen by the buyer.
       *
       * There is no convention for which tool does the work, and guessing with
       * somebody's money is not a convention. Required for an MCP agent and
       * meaningless for one that speaks AiKi's own envelope.
       */
      agentTool?: string
      /** Or hire this one person, by address. Nothing is dispatched: they see it. */
      hirePerson?: string
    }
  }>(
    '/v1/tasks',
    {
      preHandler: async (request, reply) => {
        const key = request.headers['idempotency-key']
        if (key === undefined) return
        const session = requireSession(request, reply)
        if (!session) return reply
        if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key))
          return reply.code(400).send({
            error: {
              code: 'INVALID_IDEMPOTENCY_KEY',
              message: 'Use a request key of 1 to 200 printable characters.',
              retryable: false,
            },
          })
        if (!input.tasks.beginCreateRequest || !input.tasks.completeCreateRequest)
          return reply.code(503).send({
            error: {
              code: 'TASK_IDEMPOTENCY_UNAVAILABLE',
              message: 'This deployment cannot safely retry task requests yet.',
              retryable: false,
            },
          })
        let requestHash: string
        try {
          requestHash = hashCanonicalJson((request.body ?? {}) as JsonValue)
        } catch {
          return reply.code(400).send({
            error: {
              code: 'TASK_INVALID_BODY',
              message: 'The task request is too complex.',
              retryable: false,
            },
          })
        }
        const claim = await input.tasks.beginCreateRequest(session.address, key, requestHash)
        if (claim.kind === 'conflict')
          return reply.code(409).send({
            error: {
              code: 'TASK_IDEMPOTENCY_CONFLICT',
              message:
                'That request key was already used for different work. Use a new key for a new task.',
              retryable: false,
            },
          })
        if (claim.kind === 'in_progress')
          return reply
            .header('retry-after', '3')
            .code(409)
            .send({
              error: {
                code: 'TASK_REQUEST_IN_PROGRESS',
                message:
                  'The original request is still being confirmed. Check your work before creating another task.',
                retryable: true,
              },
            })
        if (claim.kind === 'replayed') {
          const recovered = await recoverFundingResponse(
            session.address,
            claim.statusCode,
            claim.body,
          )
          return reply
            .header('idempotency-replayed', 'true')
            .code(recovered ? 200 : claim.statusCode)
            .send(recovered ?? claim.body)
        }
        activeRequests.set(request, claim.id)
        reply.header('idempotency-replayed', 'false')
      },
      onSend: async (request, reply, payload) => {
        const id = activeRequests.get(request)
        if (!id) return payload
        activeRequests.delete(request)
        const body: unknown = JSON.parse(typeof payload === 'string' ? payload : String(payload))
        await input.tasks.completeCreateRequest?.(id, reply.statusCode, body)
        return payload
      },
    },
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const credits = input.credits
      if (!credits)
        return reply.code(503).send({
          error: {
            code: 'SETTLEMENT_UNAVAILABLE',
            message: 'This deployment has no points ledger, so it cannot hold money for a task.',
            retryable: false,
          },
        })

      const title = text(request.body?.title, MAX_TITLE)
      const brief = text(request.body?.brief, MAX_BRIEF)
      const kind = request.body?.kind
      const pricePoints = Number(request.body?.pricePoints ?? 0)

      if (!title || !brief)
        return reply.code(400).send({
          error: {
            code: 'TASK_INCOMPLETE',
            message: 'A task needs a title and a brief saying what done looks like.',
            retryable: false,
          },
        })
      if (!isTaskKind(kind))
        return reply.code(400).send({
          error: {
            code: 'TASK_KIND_UNKNOWN',
            // Named rather than hinted at, because the list IS the safety
            // mechanism and somebody refused by it deserves to see it.
            message: `kind must be one of: ${Object.keys(TASK_KINDS).join(', ')}.`,
            retryable: false,
          },
        })
      if (!Number.isFinite(pricePoints) || pricePoints < MIN_PRICE_POINTS)
        return reply.code(400).send({
          error: {
            code: 'TASK_PRICE_TOO_LOW',
            message: `A task pays at least ${MIN_PRICE_POINTS} points.`,
            retryable: false,
          },
        })
      if (!Number.isSafeInteger(pricePoints))
        return reply.code(400).send({
          error: {
            code: 'TASK_PRICE_INVALID',
            message: 'The offer must be a safe whole number of points.',
            retryable: false,
          },
        })
      const priced = priceJob(BigInt(pricePoints))
      const total = Number(priced.total)
      if (!Number.isSafeInteger(total))
        return reply.code(400).send({
          error: {
            code: 'TASK_PRICE_INVALID',
            message: 'The offer plus the platform fee is too large.',
            retryable: false,
          },
        })

      /*
       * How long whoever claims it has. The poster chooses, because only they know
       * whether this is twenty minutes or two days, and it is bounded so a task
       * cannot be posted with a window long enough to lock the money up for a
       * year by accident.
       */
      const requestedHours = Number(request.body?.workHours ?? 48)
      if (!Number.isFinite(requestedHours))
        return reply.code(400).send({
          error: {
            code: 'TASK_DURATION_INVALID',
            message: 'The work duration must be a finite number of hours.',
            retryable: false,
          },
        })
      const workHours = Math.min(720, Math.max(1, Math.trunc(requestedHours)))

      /*
       * Hiring a named agent rather than posting openly.
       *
       * Resolved before any money moves, because everything here can refuse and a
       * refusal after the charge is a refusal that costs somebody.
       */
      let assigned:
        | { agentId: string; owner: string; endpoint: string; transport: string; tool?: string }
        | undefined
      if (request.body?.assignAgentId) {
        if (!input.publicUrl || !input.deliverySecret)
          return reply.code(503).send({
            error: {
              code: 'DISPATCH_UNAVAILABLE',
              message: 'Task delivery is not configured. Nothing was charged.',
              retryable: false,
            },
          })
        if (!input.agentContact)
          return reply.code(503).send({
            error: {
              code: 'HIRING_UNAVAILABLE',
              message: 'This deployment cannot look up agents, so it cannot hire one.',
              retryable: false,
            },
          })
        const contact = await input.agentContact(request.body.assignAgentId)
        if (!contact?.owner)
          return reply.code(422).send({
            error: {
              code: 'AGENT_NOT_HIREABLE',
              message: 'The registry records no owner for this agent, so there is nobody to pay.',
              retryable: false,
            },
          })
        if (!contact.live)
          return reply.code(422).send({
            error: {
              code: 'AGENT_NOT_LIVE',
              // The specific reason when there is one. A buyer cannot tell a
              // dead agent from one whose operator has simply not published a
              // proof file, and only one of those is worth waiting for.
              message: `${contact.reason ?? 'This agent is not currently available for hire.'} Nothing was charged.`,
              retryable: false,
            },
          })
        if (contact.compatible === false)
          return reply.code(422).send({
            error: {
              code: 'AGENT_TASK_PROTOCOL_UNSUPPORTED',
              message:
                contact.reason ??
                'This agent does not support AiKi task delivery. Nothing was charged.',
              retryable: false,
            },
          })
        if (!contact.endpoint)
          return reply.code(422).send({
            error: {
              code: 'AGENT_HAS_NO_ENDPOINT',
              message:
                'This agent declares no endpoint, so there is nowhere to send the work. Post it openly instead.',
              retryable: false,
            },
          })
        const transport = contact.protocol === 'mcp' ? 'mcp' : DISPATCH_PROTOCOL
        let tool: string | undefined
        if (transport === 'mcp') {
          /*
           * The tool has to be named, and named from what the agent is
           * advertising right now. A buyer who cannot say which capability they
           * are paying for has not agreed to anything specific, and a name that
           * is no longer on the list belongs to a different agent than the one
           * being hired.
           */
          tool = typeof request.body.agentTool === 'string' ? request.body.agentTool : ''
          if (!tool || !contact.tools?.some((candidate) => candidate.name === tool))
            return reply.code(422).send({
              error: {
                code: 'AGENT_TOOL_REQUIRED',
                message: contact.tools?.length
                  ? `Name which capability to pay for. This agent offers: ${contact.tools
                      .map((candidate) => candidate.name)
                      .join(', ')}.`
                  : 'This agent advertises no capability to pay for. Nothing was charged.',
                retryable: false,
              },
            })
        }
        assigned = {
          agentId: request.body.assignAgentId,
          owner: contact.owner,
          endpoint: contact.endpoint,
          transport,
          ...(tool ? { tool } : {}),
        }
      }

      /*
       * Hiring one person rather than opening the work.
       *
       * Nothing is sent anywhere: a person is not an endpoint. The work appears in
       * their own list with the same clock on it a claimed task has, so somebody
       * who is commissioned and then goes quiet frees the buyer's money on exactly
       * the terms everybody else does.
       */
      const hirePerson = request.body?.hirePerson
      if (hirePerson && !/^0x[0-9a-fA-F]{40}$/.test(hirePerson))
        return reply.code(400).send({
          error: {
            code: 'NOT_AN_ADDRESS',
            message: 'Hire somebody by their address.',
            retryable: false,
          },
        })
      if (hirePerson && hirePerson.toLowerCase() === session.address.toLowerCase())
        return reply.code(400).send({
          error: {
            code: 'CANNOT_HIRE_YOURSELF',
            message: 'Paying yourself through escrow is not a trade, it is a fee.',
            retryable: false,
          },
        })
      if (hirePerson && request.body?.assignAgentId)
        return reply.code(400).send({
          error: {
            code: 'ONE_SELLER',
            message: 'Hire an agent or a person, not both.',
            retryable: false,
          },
        })

      const outlay = settlementForPoints(total, SETTLEMENT.decimals)

      /*
       * An agent posting under a mandate spends against that mandate.
       *
       * Optional, because a person posting their own work answers to nobody but
       * their balance. Enforced when present, because an agent given a budget for
       * on-chain actions has not been given an unlimited one for human labour,
       * and buying work is the easiest way around a limit that only reads calls.
       */
      let releaseCap: (() => Promise<void>) | null = null
      if (request.body?.authorizationId) {
        const authorization = await input.jobs.getAuthorization(request.body.authorizationId)
        if (authorization.owner && authorization.owner !== session.address.toLowerCase())
          return reply.code(403).send({
            error: {
              code: 'NOT_YOUR_MANDATE',
              message: 'That mandate belongs to somebody else.',
              retryable: false,
            },
          })
        const verdict = await input.jobs.attemptPurchase(
          request.body.authorizationId,
          outlay,
          new Date().toISOString(),
          SETTLEMENT.address,
        )
        if (!verdict.allow)
          return reply.code(403).send({
            error: { code: 'MANDATE_REFUSED', message: verdict.reason, retryable: false },
          })
        const authorizationId = request.body.authorizationId
        releaseCap = () => input.jobs.releaseSpend(authorizationId, outlay)
      }

      let task: TaskRecord
      try {
        task = await input.tasks.create({
          poster: session.address,
          ...(request.body?.authorizationId
            ? { authorizationId: request.body.authorizationId }
            : {}),
          title,
          brief,
          kind,
          pricePoints,
          feePoints: Number(priced.platformFee),
          totalPoints: total,
          outlay,
          workHours,
          ...(assigned ? { assigned: { agentId: assigned.agentId, owner: assigned.owner } } : {}),
          ...(hirePerson ? { hiredPerson: hirePerson } : {}),
        })
      } catch (error) {
        // No ledger transfer or dispatch has happened yet.
        await releaseCap?.()
        throw error
      }

      try {
        await credits.transfer({
          ...fundingTransfer(task),
          detail: { taskId: task.id, kind },
        })
      } catch (error) {
        let recorded: boolean | null = null
        try {
          recorded = (await credits.transferRecorded?.(fundingTransfer(task))) ?? null
        } catch {
          // A commit can succeed before its acknowledgement is lost. Never
          // infer failure from an exception or infer funding from total escrow.
        }
        if (
          error instanceof InsufficientBalance &&
          (recorded === false || !credits.transferRecorded)
        ) {
          await input.tasks.advance(
            task.id,
            ['OPEN', 'CLAIMED'],
            'CANCELLED',
            'The money could not be held.',
          )
          await releaseCap?.()
          return reply.code(402).send({
            error: {
              code: 'INSUFFICIENT_POINTS',
              message: `This task costs ${total} points and the balance is ${error.held}.`,
              retryable: false,
            },
          })
        }
        if (recorded !== true) {
          await input.tasks.noteDispatch(
            task.id,
            'Payment confirmation is pending. No work was sent. The spending allowance stays reserved until the task funding is reconciled.',
            false,
          )
          return fundingUnconfirmed(reply, task.id)
        }
        // Both exact funding legs exist. Continue this one task, including when
        // a duplicate reference reported that the transfer was already made.
      }

      /*
       * Ask the agent, now that the money behind the request is real.
       *
       * After funding on purpose. An agent asked to work before the money is
       * committed is being asked on a promise, which is the thing this whole board
       * exists not to do.
       *
       * Uncertainty here does not cancel the request. The task exists, the money is
       * held, and what happened when we called is written down: if the agent never
       * answers, its claim runs out on the same clock a person's would and the
       * buyer takes their money back. Most of this registry will not answer, and
       * that being visible is the point rather than the problem.
       */
      let refundedPoints = 0
      /*
       * MCP needs no callback, so it must not be gated on callback settings.
       * AiKi's own envelope carries a delivery URL and a derived token, and
       * without those there is nowhere for a late answer to go; an MCP tool
       * answers in the same call or not at all.
       */
      const dispatchable =
        assigned &&
        (assigned.transport === 'mcp' || Boolean(input.publicUrl && input.deliverySecret))
      if (assigned && dispatchable) {
        const outcome =
          assigned.transport === 'mcp'
            ? await dispatchOverMcp({
                endpoint: assigned.endpoint,
                tool: assigned.tool ?? '',
                /*
                 * The task id is the intent. It exists in the database before
                 * this call is made and it is the same value on a retry, so a
                 * timeout cannot buy the same work twice from a provider that
                 * honours it. The grid agents on this registry key idempotency
                 * on exactly this field.
                 */
                arguments: { intentId: task.id, brief, title },
              })
            : await dispatchToAgent({
                endpoint: assigned.endpoint,
                envelope: {
                  protocol: DISPATCH_PROTOCOL,
                  taskId: task.id,
                  agentId: assigned.agentId,
                  title,
                  brief,
                  pricePoints,
                  deadline: new Date(Date.now() + workHours * 3_600_000).toISOString(),
                  callback: {
                    url: `${input.publicUrl ?? ''}/v1/tasks/${task.id}/deliver`,
                    token: deliveryToken(input.deliverySecret ?? '', task.id),
                  },
                },
              })
        if (outcome.declined && !outcome.delivered) {
          try {
            const refunded = await input.tasks.refundDeclinedAssignment(
              task.id,
              assigned.agentId,
              outcome.note,
            )
            if (refunded) refundedPoints = refunded.totalPoints
          } catch {
            return reply.code(503).send({
              error: {
                code: 'TASK_REFUND_UNCONFIRMED',
                message:
                  'The agent declined, but AiKi could not confirm the refund. Keep this task and check Work before creating another hire.',
                taskId: task.id,
                workUrl: '/work',
                retryable: false,
              },
            })
          }
        } else {
          await input.tasks.noteDispatch(task.id, outcome.note)
          if (outcome.delivered)
            await input.tasks.recordDelivery(task.id, assigned.agentId, outcome.delivered)
        }
      }

      const settled = (await input.tasks.get(task.id)) ?? task
      return reply.code(201).send({
        ...settled,
        outlay: settled.outlay.toString(),
        heldPoints: refundedPoints ? 0 : total,
        ...(refundedPoints ? { refundedPoints } : {}),
      })
    },
  )

  /**
   * People who can be found and hired.
   *
   * Public, like the board and the registry. Somebody deciding whether this is
   * worth signing in for should be able to see who is here.
   */
  app.get('/v1/sellers', async (_request, reply) => {
    if (!input.sellers)
      return reply.code(503).send({
        error: {
          code: 'SELLERS_UNAVAILABLE',
          message: 'This deployment has no seller listings.',
          retryable: false,
        },
      })
    return {
      kinds: TASK_KINDS,
      sellers: await input.sellers.list(50),
      minimumPricePoints: MIN_PRICE_POINTS,
      feeBasisPoints: PLATFORM_FEE_BPS,
    }
  })

  app.get<{ Params: { address: string } }>('/v1/sellers/:address', async (request, reply) => {
    const seller = await input.sellers?.get(request.params.address)
    if (!seller)
      return reply.code(404).send({
        error: { code: 'SELLER_NOT_FOUND', message: 'Nobody is listed there.', retryable: false },
      })
    return seller
  })

  /**
   * List yourself, or change what you already listed.
   *
   * Keyed on the session address, so nobody can write anybody else's listing and
   * there is no ownership check to get wrong: the only listing you can touch is
   * the one at the address you signed in with.
   */
  app.put<{
    Body: {
      name?: string
      blurb?: string
      kinds?: string[]
      ratePoints?: number
      available?: boolean
    }
  }>('/v1/sellers/me', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    if (!input.sellers)
      return reply.code(503).send({
        error: {
          code: 'SELLERS_UNAVAILABLE',
          message: 'This deployment has no seller listings.',
          retryable: false,
        },
      })

    const name = text(request.body?.name, 60)
    const blurb = text(request.body?.blurb, 400)
    const requestedKinds = request.body?.kinds
    if (!Array.isArray(requestedKinds) || requestedKinds.some((kind) => !isTaskKind(kind)))
      throw new ClientError('Choose the types of work you offer from the available list.', {
        code: 'LISTING_KINDS_INVALID',
      })
    const kinds = [...new Set(requestedKinds)] as TaskKind[]
    const ratePoints = request.body?.ratePoints === undefined ? 0 : request.body.ratePoints
    if (typeof ratePoints !== 'number' || !Number.isSafeInteger(ratePoints) || ratePoints < 0)
      throw new ClientError(
        'Enter your suggested offer as a whole, non-negative number of points.',
        {
          code: 'LISTING_RATE_INVALID',
        },
      )
    if (request.body?.available !== undefined && typeof request.body.available !== 'boolean')
      throw new ClientError('Availability must be on or off.', {
        code: 'LISTING_AVAILABILITY_INVALID',
      })
    if (!name || !blurb)
      return reply.code(400).send({
        error: {
          code: 'LISTING_INCOMPLETE',
          message: 'A listing needs a name and a sentence about what you do.',
          retryable: false,
        },
      })
    if (!kinds.length)
      return reply.code(400).send({
        error: {
          code: 'NO_KINDS',
          // The same allowlist tasks are posted under, so there is no kind
          // somebody can offer that nobody is able to ask for.
          message: `Say what you take, from: ${Object.keys(TASK_KINDS).join(', ')}.`,
          retryable: false,
        },
      })

    return input.sellers.put({
      address: session.address,
      name,
      blurb,
      kinds,
      ratePoints,
      available: request.body?.available !== false,
    })
  })

  /**
   * Where a hired agent sends work back to.
   *
   * Unauthenticated by session and authenticated by token, because the caller is
   * a third-party server with no account here. The token is an HMAC of the task
   * id, so it is not stored anywhere, cannot be guessed, and only exists for a
   * task that was actually dispatched.
   */
  app.post<{ Params: { id: string }; Body: { token?: string; result?: string } }>(
    '/v1/tasks/:id/deliver',
    async (request, reply) => {
      const secret = input.deliverySecret
      const token = request.body?.token ?? request.headers['x-aiki-delivery-token']?.toString()
      if (!secret || !token || !tokenMatches(secret, request.params.id, token))
        return reply.code(401).send({
          error: {
            code: 'DELIVERY_TOKEN_INVALID',
            message: 'That is not the delivery token for this task.',
            retryable: false,
          },
        })

      const result = text(request.body?.result, MAX_SUBMISSION)
      if (!result)
        return reply.code(400).send({
          error: { code: 'DELIVERY_EMPTY', message: 'Send a result.', retryable: false },
        })

      const task = await input.tasks.get(request.params.id)
      if (!task?.assignedAgentId)
        return reply.code(404).send({
          error: { code: 'TASK_NOT_FOUND', message: 'No such dispatched task.', retryable: false },
        })

      const delivered = await input.tasks.recordDelivery(task.id, task.assignedAgentId, result)
      if (!delivered)
        return reply.code(409).send({
          error: {
            code: 'TOO_LATE',
            message: `This is ${task.status}. Work sent after the deadline is not taken, because the money may already have gone back.`,
            retryable: false,
          },
        })
      return { taskId: delivered.id, status: delivered.status }
    },
  )

  /** Take a task. One claimant wins, decided by the database. */
  app.post<{ Params: { id: string } }>('/v1/tasks/:id/claim', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const existing = await input.tasks.get(request.params.id)
    if (existing && !(await requireFunding(existing, reply))) return reply
    const claimed = await input.tasks.claim(request.params.id, session.address)
    if (!claimed) {
      const task = await input.tasks.get(request.params.id)
      return reply.code(409).send({
        error: {
          code: 'TASK_NOT_CLAIMABLE',
          message: !task
            ? 'No such task.'
            : task.poster === session.address.toLowerCase()
              ? 'You posted this one. Somebody else has to do it.'
              : task.status === 'CLAIMED'
                ? 'Somebody is working on this. It becomes claimable again if they run out of time.'
                : `This one is ${task.status}.`,
          retryable: false,
        },
      })
    }
    return { ...claimed, outlay: claimed.outlay.toString() }
  })

  /** Hand the work in. Only the person doing it, and only once. */
  app.post<{ Params: { id: string }; Body: { submission?: string } }>(
    '/v1/tasks/:id/submit',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const submission = text(request.body?.submission, MAX_SUBMISSION)
      if (!submission)
        return reply.code(400).send({
          error: {
            code: 'SUBMISSION_EMPTY',
            message: 'Say what you did, or paste what you produced.',
            retryable: false,
          },
        })
      const submitted = await input.tasks.submit(request.params.id, session.address, submission)
      if (!submitted)
        return reply.code(409).send({
          error: {
            code: 'TASK_NOT_YOURS_TO_SUBMIT',
            message: 'This is not a task you have claimed, or you have already handed it in.',
            retryable: false,
          },
        })
      return { ...submitted, outlay: submitted.outlay.toString() }
    },
  )

  /**
   * Accept the work, and the money goes to whoever did it.
   *
   * Out of the escrow it was put into, never minted, so this cannot pay out more
   * than was committed. Keyed on the task, so accepting twice pays once.
   */
  app.post<{ Params: { id: string } }>('/v1/tasks/:id/accept', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const credits = input.credits
    const treasury = input.settlementTreasury
    if (!credits || !treasury)
      return reply.code(503).send({
        error: {
          code: 'SETTLEMENT_UNAVAILABLE',
          message: 'This deployment has no points ledger or no treasury, so it cannot pay.',
          retryable: false,
        },
      })

    const task = await input.tasks.get(request.params.id)
    if (!task || task.poster !== session.address.toLowerCase())
      return reply.code(404).send({
        error: { code: 'TASK_NOT_FOUND', message: 'No such task of yours.', retryable: false },
      })
    const result = await finalizePayment(task, session.address, 'accept', reply)
    if (!result) return reply
    return {
      ...result.task,
      outlay: result.task.outlay.toString(),
      paidTo: result.task.claimedBy,
      paidPoints: result.task.pricePoints,
      feePoints: result.task.feePoints,
      alreadyFinalized: result.alreadyFinalized,
    }
  })

  /**
   * Take the payment for work the poster never answered.
   *
   * The mirror of the claim deadline, and the more important of the two, because
   * here the work has already been done. A poster who goes quiet holding somebody
   * else's finished work should not also be holding their money. After the review
   * window the person who did it releases the payment themselves.
   *
   * A poster who thinks the work is wrong has a button that says so, and using
   * it stops this. Doing nothing is not a way to avoid paying.
   */
  app.post<{ Params: { id: string } }>('/v1/tasks/:id/release', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const credits = input.credits
    const treasury = input.settlementTreasury
    if (!credits || !treasury)
      return reply.code(503).send({
        error: {
          code: 'SETTLEMENT_UNAVAILABLE',
          message: 'This deployment has no points ledger or no treasury, so it cannot pay.',
          retryable: false,
        },
      })

    const task = await input.tasks.get(request.params.id)
    if (!task)
      return reply.code(404).send({
        error: { code: 'TASK_NOT_FOUND', message: 'No such task.', retryable: false },
      })

    const result = await finalizePayment(task, session.address, 'release', reply)
    if (!result) return reply
    return {
      ...result.task,
      outlay: result.task.outlay.toString(),
      paidTo: result.task.claimedBy,
      paidPoints: result.task.pricePoints,
      feePoints: result.task.feePoints,
      alreadyFinalized: result.alreadyFinalized,
    }
  })

  /**
   * Say it is not what was asked for.
   *
   * This does not refund. Somebody did work, and deciding who is right about
   * whether it was the work asked for is a dispute, which AiKi cannot resolve
   * yet and will not pretend to. The money stays in escrow, named against this
   * task, and the record says who said what. Better a held balance somebody can
   * point at than a fast wrong answer in either direction.
   */
  app.post<{ Params: { id: string }; Body: { because?: string } }>(
    '/v1/tasks/:id/decline',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const task = await input.tasks.get(request.params.id)
      if (!task || task.poster !== session.address.toLowerCase())
        return reply.code(404).send({
          error: { code: 'TASK_NOT_FOUND', message: 'No such task of yours.', retryable: false },
        })
      const disputed = await input.tasks.advance(
        task.id,
        ['SUBMITTED'],
        'DISPUTED',
        text(request.body?.because, 500) || 'The poster said this is not what was asked for.',
      )
      if (!disputed)
        return reply.code(409).send({
          error: {
            code: 'NOTHING_TO_DECLINE',
            message: `Only submitted work can be declined. This one is ${task.status}.`,
            retryable: false,
          },
        })
      return {
        ...disputed,
        outlay: disputed.outlay.toString(),
        note: 'The money stays in escrow against this task until the dispute is settled. AiKi does not resolve disputes yet.',
      }
    },
  )

  /**
   * Take work back off the board, while nobody is doing it.
   *
   * Only from OPEN. Once somebody has claimed a task the poster cannot pull the
   * money: a poster who could read a submission and then withdraw has been
   * handed a way to get work for nothing, and it is the failure the research on
   * this primitive singles out. The database enforces it, not this comment.
   */
  app.post<{ Params: { id: string } }>('/v1/tasks/:id/cancel', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const credits = input.credits
    if (!credits)
      return reply.code(503).send({
        error: {
          code: 'SETTLEMENT_UNAVAILABLE',
          message: 'This deployment has no points ledger, so it cannot give the money back.',
          retryable: false,
        },
      })
    const task = await input.tasks.get(request.params.id)
    if (!task || task.poster !== session.address.toLowerCase())
      return reply.code(404).send({
        error: { code: 'TASK_NOT_FOUND', message: 'No such task of yours.', retryable: false },
      })

    const result = await finalizePayment(task, session.address, 'cancel', reply)
    if (!result) return reply
    return {
      ...result.task,
      outlay: result.task.outlay.toString(),
      refundedPoints: result.task.totalPoints,
      alreadyFinalized: result.alreadyFinalized,
    }
  })
}
