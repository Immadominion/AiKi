import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth/guard.js'
import { settlementForPoints } from '../credits/pricing.js'
import {
  type CreditStore,
  DuplicateCharge,
  ESCROW_ACCOUNT,
  InsufficientBalance,
} from '../credits/store.js'
import type { JobService } from '../jobs/service.js'
import { priceJob, SETTLEMENT } from '../settlement/pricing.js'
import { isTaskKind, TASK_KINDS } from './kinds.js'
import type { TaskStore } from './store.js'

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

export function registerTaskRoutes(
  app: FastifyInstance,
  input: {
    tasks: TaskStore
    credits?: CreditStore
    jobs: JobService
    settlementTreasury?: string
  },
) {
  const text = (value: unknown, max: number) =>
    typeof value === 'string' ? value.trim().slice(0, max) : ''

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
    if (!task)
      return reply.code(404).send({
        error: { code: 'TASK_NOT_FOUND', message: 'No such task.', retryable: false },
      })
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
      authorizationId?: string
    }
  }>('/v1/tasks', async (request, reply) => {
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
    const pricePoints = Math.trunc(Number(request.body?.pricePoints ?? 0))

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

    const priced = priceJob(BigInt(pricePoints))
    const total = Number(priced.total)
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

    const task = await input.tasks.create({
      poster: session.address,
      ...(request.body?.authorizationId ? { authorizationId: request.body.authorizationId } : {}),
      title,
      brief,
      kind,
      pricePoints,
      feePoints: Number(priced.platformFee),
      totalPoints: total,
      outlay,
    })

    try {
      await credits.transfer({
        from: session.address,
        to: ESCROW_ACCOUNT,
        points: total,
        reason: 'task_funding',
        reference: `task:${task.id}:funding`,
        detail: { taskId: task.id, kind },
      })
    } catch (error) {
      /*
       * The task exists and the money did not move, so it must not sit on the
       * board looking funded. Cancelled rather than deleted: a row somebody can
       * read is better than a gap, and the resolution says what happened.
       */
      await input.tasks.advance(task.id, ['OPEN'], 'CANCELLED', 'The money could not be held.')
      await releaseCap?.()
      if (error instanceof InsufficientBalance)
        return reply.code(402).send({
          error: {
            code: 'INSUFFICIENT_POINTS',
            message: `This task costs ${total} points and the balance is ${error.held}.`,
            retryable: false,
          },
        })
      if (error instanceof DuplicateCharge)
        return reply.code(409).send({
          error: {
            code: 'TASK_ALREADY_FUNDED',
            message: 'This task has already been paid for.',
            retryable: false,
          },
        })
      throw error
    }

    return reply.code(201).send({ ...task, outlay: task.outlay.toString(), heldPoints: total })
  })

  /** Take a task. One claimant wins, decided by the database. */
  app.post<{ Params: { id: string } }>('/v1/tasks/:id/claim', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
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
              : `Somebody already took this. It is ${task.status}.`,
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
    if (!task.claimedBy || task.status !== 'SUBMITTED')
      return reply.code(409).send({
        error: {
          code: 'NOTHING_TO_ACCEPT',
          message: `Work is accepted once it is handed in. This one is ${task.status}.`,
          retryable: false,
        },
      })

    // Claim the payout before any money moves, on the same reasoning the job
    // routes use: only one of accepting and disputing may take a task out of
    // SUBMITTED, or both could pay out against one funding.
    const claimed = await input.tasks.advance(task.id, ['SUBMITTED', 'SETTLED'], 'SETTLED')
    if (!claimed)
      return reply.code(409).send({
        error: {
          code: 'TASK_ALREADY_DECIDED',
          message: 'Somebody already decided this one.',
          retryable: false,
        },
      })

    const pay = async (to: string, points: number, reason: string) => {
      if (points <= 0) return
      try {
        await credits.transfer({
          from: ESCROW_ACCOUNT,
          to,
          points,
          reason,
          reference: `task:${task.id}:${reason}`,
          detail: { taskId: task.id },
        })
      } catch (error) {
        // Already paid. A retry after a timeout is not a mistake and must not
        // pay twice, which the reference guarantees.
        if (!(error instanceof DuplicateCharge)) throw error
      }
    }
    await pay(task.claimedBy, task.pricePoints, 'task_earnings')
    await pay(treasury, task.feePoints, 'platform_fee')

    return {
      ...claimed,
      outlay: claimed.outlay.toString(),
      paidTo: task.claimedBy,
      paidPoints: task.pricePoints,
      feePoints: task.feePoints,
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

    /*
     * From OPEN only, and CANCELLED is deliberately not a source.
     *
     * Allowing re-entry here was a way to spend a mandate without limit. The
     * refund transfer is idempotent by reference, so a second cancel moved no
     * money and looked harmless, but `releaseSpend` is not: it subtracts every
     * time it is called. Post a task, cancel it, cancel it again, and again,
     * and the mandate's spend counter walks down to zero while the money spent
     * on OTHER tasks stays spent. The cap stops meaning anything.
     *
     * A crash between this write and the refund below leaves the money in
     * escrow against a cancelled task, which is visible in the ledger check and
     * recoverable by hand. That is the right way round: money briefly stuck and
     * countable beats a cap that quietly resets.
     */
    const cancelled = await input.tasks.advance(
      task.id,
      ['OPEN'],
      'CANCELLED',
      'The poster took it back.',
    )
    if (!cancelled)
      return reply.code(409).send({
        error: {
          code: 'TASK_NOT_CANCELLABLE',
          message:
            task.status === 'CLAIMED' || task.status === 'SUBMITTED'
              ? 'Somebody is working on this. The money stays where it is until they hand it in.'
              : task.status === 'CANCELLED'
                ? 'This one is already cancelled and the money is already back.'
                : `Only open work can be taken back. This one is ${task.status}.`,
          retryable: false,
        },
      })

    let refunded = true
    try {
      await credits.transfer({
        from: ESCROW_ACCOUNT,
        to: task.poster,
        points: task.totalPoints,
        reason: 'task_refund',
        reference: `task:${task.id}:refund`,
        detail: { taskId: task.id },
      })
    } catch (error) {
      // Already refunded. The cap was released with it, so it must not be
      // released a second time.
      if (!(error instanceof DuplicateCharge)) throw error
      refunded = false
    }
    if (refunded && task.authorizationId)
      await input.jobs.releaseSpend(task.authorizationId, task.outlay)

    return { ...cancelled, outlay: cancelled.outlay.toString(), refundedPoints: task.totalPoints }
  })
}
