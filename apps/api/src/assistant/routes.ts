import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth/guard.js'
import { readCreditFinalizedBlock, verifyCreditNetwork } from '../config/credits-network.js'
import { creditDeposit, DEPOSIT_CONFIRMATIONS, type DepositConfig } from '../credits/deposit.js'
import {
  DEFAULT_MODEL,
  explainCost,
  MINIMUM_BALANCE_POINTS,
  MODELS,
  POINTS_PER_USD,
  TURN_HOLD_POINTS,
  WELCOME_GRANT_POINTS,
  WELCOME_GRANTS_PER_DAY,
} from '../credits/pricing.js'
import {
  type CreditStore,
  DuplicateDeposit,
  InsufficientBalance,
  RESERVE_ACCOUNT,
  REVENUE_ACCOUNT,
} from '../credits/store.js'
import { ClientError } from '../http/errors.js'
import { hashCanonicalJson } from '../marketplace/canonical-json.js'
import { assistantLimits } from './billing.js'
import type { ConversationStore } from './conversations.js'
import { assistantMessages } from './input.js'
import { runAssistant } from './run.js'
import { AssistantRunFailure } from './usage.js'

/**
 * Fast mode over HTTP, and the points that pay for it.
 *
 * The order in `POST /v1/assistant/messages` is the part worth reading. The
 * money is taken BEFORE the model runs, the loop is given that number as a
 * ceiling it must stop under, and whatever is left over goes back in the same
 * request. A turn cannot be priced until it is over, so the only way to keep it
 * inside what somebody has is to hold the money first and let the work stop
 * when the money would run out.
 *
 * The spend is deliberately not conditional on the turn succeeding. The tokens
 * were spent whether or not the answer was good, and quietly eating the cost of
 * failed turns is how a metered product becomes a loss-making one.
 */

export interface AssistantConfig {
  credits: CreditStore
  /** Absent means no key is configured and Fast mode says so instead of failing oddly. */
  apiKey?: string
  model?: string
  /** Where the assistant reaches this same API. Loopback. */
  selfUrl: string
  deposits?: DepositConfig
  /** Selected deployment, never inferred from the wallet's sign-in network. */
  executionChainId?: 56 | 97
  conversations?: ConversationStore
}

export function registerAssistantRoutes(app: FastifyInstance, config: AssistantConfig) {
  const model = config.model ?? DEFAULT_MODEL
  const limits = assistantLimits()

  /**
   * The one-off welcome grant, issued the first time an account is looked at.
   *
   * Idempotent by construction: the reference is the address, and `deposit`
   * rejects a reference it has already credited, so a refresh, a retry or two
   * concurrent requests all leave the account with exactly one grant. Failure
   * to grant is never fatal, because a visitor who cannot be given free points
   * should still be able to read their balance.
   */
  async function withWelcomeGrant(address: string): Promise<void> {
    try {
      /*
       * Bounded before it is issued. An address costs nothing to make, so
       * without a ceiling this route hands out real model spend to anybody who
       * can sign a message, as many times as they can be bothered to.
       */
      await config.credits.grantWelcome({
        owner: address,
        points: WELCOME_GRANT_POINTS,
        dailyLimit: WELCOME_GRANTS_PER_DAY,
      })
    } catch (error) {
      if (error instanceof DuplicateDeposit) return
      app.log.warn({ err: error }, 'welcome grant failed')
    }
  }

  app.get('/v1/credits', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    await withWelcomeGrant(session.address)
    const [balance, history] = await Promise.all([
      config.credits.balance(session.address),
      config.credits.history(session.address, 20),
    ])
    return {
      balance,
      // Said in money as well as points, because "3,400 points" means nothing to
      // somebody who has not been told what a point is.
      worthUsd: balance / POINTS_PER_USD,
      pointsPerUsdt: POINTS_PER_USD,
      /*
       * What a point can and cannot do, said rather than left to be assumed.
       *
       * "Worth $0.58" reads as money you can take out, and you cannot: points
       * are bought with a token and spent inside AiKi, and there is no route
       * that converts them back. Somebody who has just been paid for a piece of
       * work is precisely the person who would assume otherwise, so the sentence
       * travels with the number rather than sitting on a page they may not read.
       */
      redeemable: false,
      redeemableNote:
        'Points buy work and Fast mode turns inside AiKi. There is no way to withdraw them yet.',
      minimumToAsk: MINIMUM_BALANCE_POINTS,
      model: MODELS[model]?.label ?? model,
      limits: {
        ...limits,
        walletConcurrent: 1,
        maximumTurnPoints: TURN_HOLD_POINTS,
        welcomePoints: WELCOME_GRANT_POINTS,
        welcomeGrantsPerDay: WELCOME_GRANTS_PER_DAY,
      },
      history,
    }
  })

  app.post<{ Body: { transactionHash?: string } }>(
    '/v1/credits/deposits',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      if (!config.deposits)
        throw new ClientError('This deployment cannot take deposits.', {
          code: 'DEPOSITS_UNAVAILABLE',
          statusCode: 503,
        })
      try {
        return await creditDeposit({
          credits: config.credits,
          config: config.deposits,
          owner: session.address,
          transactionHash: String(request.body?.transactionHash ?? ''),
        })
      } catch (error) {
        if (error instanceof ClientError && error.code === 'DEPOSIT_CONFIRMING')
          return reply
            .header('retry-after', '3')
            .code(409)
            .send({
              error: { code: error.code, message: error.message, retryable: true },
            })
        if (error instanceof DuplicateDeposit)
          throw new ClientError('That payment has already been credited.', {
            code: 'DEPOSIT_ALREADY_CREDITED',
            statusCode: 409,
          })
        throw error
      }
    },
  )

  app.get('/v1/credits/treasury', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    // Public on purpose: somebody has to be able to see where to send money
    // before they have signed in, and the address is not a secret.
    if (!config.deposits) return { available: false }
    // A configured address must not become payment instructions before the
    // selected RPC and token have been checked on this request.
    try {
      await verifyCreditNetwork(config.deposits)
      if (config.deposits.chainId === 56) await readCreditFinalizedBlock(config.deposits)
    } catch (error) {
      if (error instanceof ClientError) throw error
      throw new ClientError(
        'The payment network could not be verified. Try again later before sending funds.',
        {
          code: 'DEPOSIT_NETWORK_UNAVAILABLE',
          statusCode: 503,
        },
      )
    }
    return {
      chainId: config.deposits.chainId,
      decimals: config.deposits.decimals,
      token: config.deposits.token,
      treasury: config.deposits.treasury,
      pointsPerUsdt: POINTS_PER_USD,
      confirmations: DEPOSIT_CONFIRMATIONS,
      finality: config.deposits.chainId === 56 ? 'finalized' : 'confirmations',
    }
  })

  app.post<{ Body: { messages?: unknown; conversationId?: unknown } }>(
    '/v1/assistant/messages',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      if (!config.apiKey)
        throw new ClientError(
          'Fast mode is not configured on this deployment. Manual mode does everything Fast mode does.',
          { code: 'ASSISTANT_UNAVAILABLE', statusCode: 503 },
        )

      const messages = assistantMessages(request.body?.messages)
      const conversationId = request.body?.conversationId
      if (
        conversationId !== undefined &&
        (typeof conversationId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId))
      )
        throw new ClientError('Choose a valid conversation.', { code: 'CONVERSATION_INVALID' })
      const suppliedKey = request.headers['idempotency-key']
      if (
        suppliedKey !== undefined &&
        (typeof suppliedKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(suppliedKey))
      )
        throw new ClientError('Use a request key of 1 to 200 printable characters.', {
          code: 'INVALID_IDEMPOTENCY_KEY',
        })
      const key = suppliedKey ?? `legacy:${randomUUID()}`
      const cookie = request.headers.cookie
      if (!cookie)
        throw new ClientError('No session cookie to act with.', { code: 'ASSISTANT_NO_SESSION' })

      await withWelcomeGrant(session.address)
      const balance = await config.credits.balance(session.address)
      const hold = Math.min(TURN_HOLD_POINTS, balance)
      const requestHash = hashCanonicalJson({
        messages: messages.map(({ role, content }) => ({ role, content })),
        ...(conversationId ? { conversationId } : {}),
      })
      const claim = await config.credits.assistantRequests.begin({
        owner: session.address,
        key,
        requestHash,
        reservedPoints: hold,
        limits,
      })
      if (claim.kind === 'conflict')
        return reply.code(409).send({
          error: {
            code: 'ASSISTANT_IDEMPOTENCY_CONFLICT',
            message:
              'This request key belongs to a different message. Start a new turn for different work.',
            retryable: false,
          },
        })
      if (claim.kind === 'refused') {
        if (claim.retryAfter) reply.header('retry-after', String(claim.retryAfter))
        return reply.code(claim.status).send({
          error: {
            code: claim.code,
            message: claim.message,
            retryable: Boolean(claim.retryAfter),
          },
        })
      }

      type Result = {
        turnId: string
        conversationId?: string
        reply: string
        steps: Awaited<ReturnType<typeof runAssistant>>['steps']
        truncated: boolean
        cost: {
          points: number
          balance: number
          held: number
          explanation: string
          pendingPoints?: number
        }
      }
      const record = async (body: unknown, status: number) => {
        if (!conversationId || !config.conversations) return
        const result = body as Result
        if (!result.reply || !result.cost || !Array.isArray(result.steps)) return
        await config.conversations.record({
          owner: session.address,
          conversationId,
          turnId: result.turnId,
          messages,
          reply: result.reply,
          steps: result.steps,
          cost: result.cost,
          status: status < 400 ? 'completed' : 'failed',
        })
      }
      if (claim.kind === 'replayed') {
        // History may have failed after billing committed. Repair it from the
        // cached response, never by running the provider or tools again.
        await record(claim.body, claim.status)
        return reply.header('idempotency-replayed', 'true').code(claim.status).send(claim.body)
      }
      const turnId = claim.id
      reply.header('idempotency-replayed', 'false')
      const finish = async (status: number, body: unknown, points = 0, uncertain = false) => {
        await config.credits.assistantRequests.complete({
          id: turnId,
          status,
          body,
          points,
          uncertain,
        })
        await record(body, status)
        return reply.code(status).send(body)
      }
      const refused = (status: number, code: string, message: string) =>
        finish(status, { turnId, error: { code, message, retryable: false } })

      if (conversationId) {
        if (!config.conversations)
          return refused(
            503,
            'CONVERSATIONS_UNAVAILABLE',
            'Saved conversations are not configured on this deployment.',
          )
        try {
          await config.conversations.prepare(session.address, conversationId, messages)
        } catch (error) {
          if (error instanceof ClientError)
            return refused(error.statusCode, error.code, error.message)
          return refused(
            503,
            'CONVERSATION_UNAVAILABLE',
            'This conversation could not be checked. Nothing was charged.',
          )
        }
      }
      if (balance < MINIMUM_BALANCE_POINTS)
        return refused(
          402,
          'ASSISTANT_NO_CREDIT',
          `Fast mode needs at least ${MINIMUM_BALANCE_POINTS} points and you have ${balance}. Manual mode is free and does everything Fast mode does.`,
        )

      const holding = {
        from: session.address,
        to: RESERVE_ACCOUNT,
        points: hold,
        reason: 'fast_mode_hold',
        reference: `turn:${turnId}:hold`,
        detail: { turnId },
      }
      try {
        await config.credits.transfer(holding)
      } catch (error) {
        if (error instanceof InsufficientBalance)
          return refused(
            402,
            'ASSISTANT_NO_CREDIT',
            `Fast mode holds ${hold} points while it answers. There are not that many available right now.`,
          )
        const confirmed = await config.credits.transferRecorded?.(holding).catch(() => false)
        if (!confirmed)
          return finish(
            503,
            {
              turnId,
              error: {
                code: 'ASSISTANT_HOLD_UNCONFIRMED',
                message:
                  'The points hold could not be confirmed. Do not submit this turn again with a new request key.',
                retryable: false,
              },
            },
            0,
            true,
          )
      }

      let turn: Awaited<ReturnType<typeof runAssistant>> | null = null
      let failure: unknown
      let uncertain = false
      try {
        turn = await runAssistant({
          apiKey: config.apiKey,
          model,
          ctx: { baseUrl: config.selfUrl, cookie, turnId, sessionAddress: session.address },
          messages,
          budgetPoints: hold,
          networkContext: {
            ...(config.executionChainId ? { executionChainId: config.executionChainId } : {}),
            ...(config.deposits ? { depositChainId: config.deposits.chainId } : {}),
          },
          onUsage: (usage, points) =>
            config.credits.assistantRequests.checkpoint(
              turnId,
              points,
              usage.inputTokens,
              usage.outputTokens,
            ),
        })
      } catch (error) {
        failure = error
        if (error instanceof AssistantRunFailure) {
          turn = error.turn
          uncertain = error.uncertain
        }
      }
      const spent = Math.min(turn?.points ?? 0, hold)
      const settle = async (movement: Parameters<CreditStore['transfer']>[0]) => {
        try {
          await config.credits.transfer(movement)
        } catch (error) {
          if (!(await config.credits.transferRecorded?.(movement).catch(() => false))) throw error
        }
      }
      try {
        if (spent > 0)
          await settle({
            from: RESERVE_ACCOUNT,
            to: REVENUE_ACCOUNT,
            points: spent,
            reason: 'fast_mode',
            reference: `turn:${turnId}:spend`,
            detail: {
              turnId,
              model,
              inputTokens: turn?.usage.inputTokens ?? 0,
              outputTokens: turn?.usage.outputTokens ?? 0,
              tools: turn?.steps.map((step) => step.tool) ?? [],
              providerPoints: turn?.points ?? 0,
              overrunPoints: Math.max(0, (turn?.points ?? 0) - hold),
            },
          })
        if (!uncertain && hold > spent)
          await settle({
            from: RESERVE_ACCOUNT,
            to: session.address,
            points: hold - spent,
            reason: 'fast_mode_hold',
            reference: `turn:${turnId}:release`,
            detail: { turnId },
          })
      } catch {
        return finish(
          503,
          {
            turnId,
            ...(conversationId ? { conversationId } : {}),
            reply:
              turn?.reply ??
              'This turn needs reconciliation. Review any recorded actions before continuing.',
            steps: turn?.steps ?? [],
            truncated: true,
            cost: {
              points: turn?.points ?? 0,
              balance: await config.credits.balance(session.address),
              held: hold,
              pendingPoints: Math.max(0, hold - (turn?.points ?? 0)),
              explanation:
                'Model usage is recorded, but points settlement needs confirmation. Do not repeat this turn.',
            },
            error: {
              code: 'ASSISTANT_SETTLEMENT_UNCONFIRMED',
              message:
                'This turn ran, but its points settlement needs confirmation. Check your work before retrying.',
              retryable: false,
            },
          },
          turn?.points ?? 0,
          true,
        )
      }
      const explanation = turn ? explainCost(turn.model, turn.usage) : 'No confirmed model usage.'
      const result: Result = {
        turnId,
        ...(conversationId ? { conversationId } : {}),
        reply: turn?.reply ?? 'Fast mode could not finish this turn. No model usage was confirmed.',
        steps: turn?.steps ?? [],
        truncated: turn?.truncated ?? true,
        cost: {
          points: spent,
          balance: await config.credits.balance(session.address),
          held: hold,
          explanation,
          ...(uncertain ? { pendingPoints: hold - spent } : {}),
        },
      }
      if (
        turn?.requiredPoints !== undefined &&
        turn.stoppedBy === 'budget' &&
        turn.points === 0 &&
        turn.steps.length === 0
      ) {
        // Settle the unused hold above before claiming that nothing was charged.
        // Persist this refusal like any other terminal turn, including its history
        // and replay response. Later budget stops still return useful partial work.
        const message =
          turn.requiredPoints > TURN_HOLD_POINTS
            ? `This turn needs ${turn.requiredPoints} points reserved. That exceeds the ${TURN_HOLD_POINTS} point limit per turn. No points were charged and no tools ran. More points will not raise this limit. Use Manual mode instead.`
            : `This turn needs ${turn.requiredPoints} points available; you have ${result.cost.balance}. No points were charged and no tools ran. ${result.cost.balance < turn.requiredPoints ? 'Add points to continue.' : 'Start a new turn when ready.'}`
        return finish(402, {
          ...result,
          reply: message,
          error: {
            code: 'ASSISTANT_BUDGET_TOO_SMALL',
            message,
            requiredPoints: turn.requiredPoints,
            availablePoints: hold,
            retryable: false,
          },
        })
      }
      if (failure)
        return finish(
          503,
          {
            ...result,
            error: {
              code: uncertain ? 'ASSISTANT_USAGE_UNCONFIRMED' : 'ASSISTANT_TURN_FAILED',
              message:
                failure instanceof AssistantRunFailure
                  ? failure.message
                  : 'Fast mode could not finish. Unused points were returned. Check your work before retrying.',
              retryable: false,
            },
          },
          turn?.points ?? 0,
          uncertain,
        )
      return finish(
        200,
        { ...result, ...(turn?.stoppedBy ? { stoppedBy: turn.stoppedBy } : {}) },
        turn?.points ?? 0,
      )
    },
  )
}
