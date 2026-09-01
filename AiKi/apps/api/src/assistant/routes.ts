import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth/guard.js'
import { creditDeposit, type DepositConfig } from '../credits/deposit.js'
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
import { runAssistant } from './run.js'

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
}

const MAX_TURN_CHARS = 8000

export function registerAssistantRoutes(app: FastifyInstance, config: AssistantConfig) {
  const model = config.model ?? DEFAULT_MODEL

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
      const since = new Date(Date.now() - 86_400_000).toISOString()
      if ((await config.credits.countSince('welcome', since)) >= WELCOME_GRANTS_PER_DAY) return
      await config.credits.deposit({
        owner: address,
        points: WELCOME_GRANT_POINTS,
        reason: 'welcome',
        reference: `welcome:${address.toLowerCase()}`,
        detail: { note: 'One-time grant so a new account can try Fast mode without paying first.' },
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
      minimumToAsk: MINIMUM_BALANCE_POINTS,
      model: MODELS[model]?.label ?? model,
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
        if (error instanceof DuplicateDeposit)
          throw new ClientError('That payment has already been credited.', {
            code: 'DEPOSIT_ALREADY_CREDITED',
            statusCode: 409,
          })
        throw error
      }
    },
  )

  app.get('/v1/credits/treasury', async () => ({
    // Public on purpose: somebody has to be able to see where to send money
    // before they have signed in, and the address is not a secret.
    ...(config.deposits
      ? {
          chainId: config.deposits.chainId,
          token: config.deposits.token,
          treasury: config.deposits.treasury,
          pointsPerUsdt: POINTS_PER_USD,
        }
      : { available: false }),
  }))

  app.post<{ Body: { messages?: Anthropic.MessageParam[] } }>(
    '/v1/assistant/messages',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply

      if (!config.apiKey)
        throw new ClientError(
          'Fast mode is not configured on this deployment. Manual mode does everything Fast mode does.',
          { code: 'ASSISTANT_UNAVAILABLE', statusCode: 503 },
        )

      const messages = request.body?.messages
      if (!Array.isArray(messages) || messages.length === 0)
        throw new ClientError('Send at least one message.', { code: 'ASSISTANT_NO_MESSAGES' })
      const size = JSON.stringify(messages).length
      if (size > MAX_TURN_CHARS)
        throw new ClientError(
          'That conversation is too long to send in one turn. Start a new one.',
          { code: 'ASSISTANT_TOO_LONG' },
        )

      await withWelcomeGrant(session.address)
      const balance = await config.credits.balance(session.address)
      if (balance < MINIMUM_BALANCE_POINTS)
        throw new ClientError(
          `Fast mode needs at least ${MINIMUM_BALANCE_POINTS} points and you have ${balance}. ` +
            `Points are bought by sending USDT to AiKi; ${POINTS_PER_USD} points per USDT. ` +
            'Manual mode is free and does everything Fast mode does.',
          { code: 'ASSISTANT_NO_CREDIT', statusCode: 402 },
        )

      const cookie = request.headers.cookie
      if (!cookie)
        throw new ClientError('No session cookie to act with.', { code: 'ASSISTANT_NO_SESSION' })

      /*
       * The money is taken before the model runs, and the turn is told what it
       * has to spend.
       *
       * This used to be a balance check followed by a charge at the end for
       * whatever the turn came to, clamped to whatever was left. Three things
       * were wrong with that and all three were visible on production. Turns
       * costing 402, 263 and 711 points passed a gate of 200. Any shortfall was
       * written off in silence, so the overrun did not even appear as a number
       * anybody could add up. And two turns in two tabs both read the same
       * balance and both judged it sufficient, which no check outside a
       * transaction can prevent.
       *
       * A hold fixes all three at once: it is taken under a row lock so a second
       * turn sees the money already gone, it is a ceiling the loop enforces
       * rather than a figure compared against afterwards, and what is not spent
       * is returned within the same request.
       */
      const hold = Math.min(TURN_HOLD_POINTS, balance)
      const turnId = randomUUID()
      try {
        await config.credits.transfer({
          from: session.address,
          to: RESERVE_ACCOUNT,
          points: hold,
          reason: 'fast_mode_hold',
          reference: `turn:${turnId}:hold`,
          detail: { turnId },
        })
      } catch (error) {
        if (error instanceof InsufficientBalance)
          throw new ClientError(
            `Fast mode holds ${hold} points while it answers and gives back what it does not use. ` +
              'There are not that many in the account right now.',
            { code: 'ASSISTANT_NO_CREDIT', statusCode: 402 },
          )
        throw error
      }

      /*
       * From here the hold MUST be resolved, whatever happens. A turn that
       * throws after the money was taken and before it was accounted for leaves
       * that money sitting in a house account owed to somebody, which is the
       * exact condition this whole area of the codebase exists to prevent.
       */
      let turn: Awaited<ReturnType<typeof runAssistant>> | null = null
      let spent = 0
      try {
        turn = await runAssistant({
          apiKey: config.apiKey,
          model,
          ctx: { baseUrl: config.selfUrl, cookie },
          messages,
          budgetPoints: hold,
        })
        // Charged whether or not the answer was good: the tokens were spent
        // either way, and eating the cost of failed turns is how a metered
        // product becomes a loss-making one. Never more than the hold, because
        // the loop stopped before it could be.
        spent = Math.min(turn.points, hold)
      } finally {
        /*
         * Spend first, return second. A crash between the two leaves the unspent
         * remainder in the reserve, which is recoverable and visible. The other
         * order would hand back the whole hold and then fail to charge, which is
         * a free turn nobody can detect afterwards.
         */
        if (spent > 0)
          await config.credits.transfer({
            from: RESERVE_ACCOUNT,
            to: REVENUE_ACCOUNT,
            points: spent,
            reason: 'fast_mode',
            reference: `turn:${turnId}:spend`,
            detail: {
              turnId,
              model: turn?.model ?? model,
              inputTokens: turn?.usage.inputTokens ?? 0,
              outputTokens: turn?.usage.outputTokens ?? 0,
              tools: turn?.steps.map((s) => s.tool) ?? [],
            },
          })
        if (hold - spent > 0)
          await config.credits.transfer({
            from: RESERVE_ACCOUNT,
            to: session.address,
            points: hold - spent,
            reason: 'fast_mode_hold',
            reference: `turn:${turnId}:release`,
            detail: { turnId },
          })
      }

      return {
        reply: turn.reply,
        steps: turn.steps,
        truncated: turn.truncated,
        ...(turn.stoppedBy ? { stoppedBy: turn.stoppedBy } : {}),
        cost: {
          points: spent,
          balance: await config.credits.balance(session.address),
          held: hold,
          // The same sum in words, so a person can check it rather than trust it.
          explanation: explainCost(turn.model, turn.usage),
        },
      }
    },
  )
}
