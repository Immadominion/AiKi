import type Anthropic from '@anthropic-ai/sdk'
import { settlementForPoints } from '../credits/pricing.js'
import { SETTLEMENT } from '../settlement/pricing.js'

/**
 * What Fast mode can actually do, and the one rule that makes it safe.
 *
 * Every tool here is an HTTP call to AiKi's own API, made with the caller's
 * session cookie. The assistant holds no privileges of its own: it can do
 * exactly what the person it is acting for could do by clicking, and nothing
 * else. A mandate it creates is theirs, a job it starts is theirs, and a route
 * that would refuse them refuses it, with the same sentence.
 *
 * That is why this is a loopback rather than a set of direct service calls. The
 * extra hop costs a millisecond and buys a property worth far more: there is one
 * implementation of every action in this product, one place where ownership is
 * checked, and no second path that could drift from it.
 *
 * Fast mode is therefore not a lesser Manual mode with a chat box. It is the
 * same surface, driven by a model instead of a mouse.
 */

export interface ToolContext {
  /** The API's own base URL. Loopback: this process talking to itself. */
  baseUrl: string
  /** The caller's session, forwarded verbatim. The assistant borrows it, never mints one. */
  cookie: string
}

export interface ToolCallResult {
  ok: boolean
  body: unknown
}

const VENUS = {
  asset: '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c',
  market: '0xb7526572FFE56AB9D7489838Bf2E18e3323b441A',
}
const REPAY_BORROW = '0x0e752702'
const toBaseUnits = (usdt: number) => Math.round(usdt * 1_000_000).toString()

const guardianConstraints = (perActionUsdt: number, totalUsdt: number, days: number) => [
  {
    kind: 'expiry',
    value: new Date(Date.now() + days * 86_400_000).toISOString(),
    tier: 'T0',
    label: `expires in ${days} days`,
  },
  {
    kind: 'contract_allowlist',
    value: [VENUS.market],
    tier: 'T0',
    label: 'only the Venus USDT market',
  },
  { kind: 'selector_allowlist', value: [REPAY_BORROW], tier: 'T0', label: 'only repaying a loan' },
  { kind: 'asset_scope', value: [VENUS.asset], tier: 'T0', label: 'only USDT' },
  {
    kind: 'per_action_cap',
    value: toBaseUnits(perActionUsdt),
    tier: 'T0',
    label: `${perActionUsdt} USDT per action`,
  },
  {
    kind: 'session_total_cap',
    value: toBaseUnits(totalUsdt),
    tier: 'T0',
    label: `${totalUsdt} USDT in total`,
  },
]

/**
 * A mandate for buying things through AiKi, rather than for acting on chain.
 *
 * Deliberately a different shape from the guardian one above, because it caps a
 * different pot. The guardian mandate caps what an agent may move in a lending
 * market, denominated in that market's asset. This caps what it may SPEND in
 * the marketplace, denominated in the asset the marketplace settles in, and the
 * two are different currencies with no oracle between them: a hundred of one is
 * not a hundred of the other, and AiKi refuses to pretend otherwise.
 *
 * Tier is claimed and overwritten by the API. It comes back T2, because AiKi's
 * points ledger is not on chain and no contract can hold a limit on it.
 *
 * Denominated in POINTS, which is what a task costs and what a balance is
 * counted in, and converted here to the base units a cap is stored in. It took
 * settlement units at first and a real turn read that as points: asked to set up
 * a mandate for a five hundred point task, the model proposed a total of 500,
 * which would have been ten thousand times what anybody intended. One unit
 * across the whole buying flow, converted in one place.
 */
const spendingConstraints = (totalPoints: number, perTaskPoints: number, days: number) => [
  {
    kind: 'expiry',
    value: new Date(Date.now() + days * 86_400_000).toISOString(),
    tier: 'T2',
    label: `expires in ${days} days`,
  },
  {
    kind: 'asset_scope',
    value: [SETTLEMENT.address],
    tier: 'T2',
    label: `only ${SETTLEMENT.symbol}, which is what AiKi settles in`,
  },
  {
    kind: 'session_total_cap',
    value: settlementForPoints(totalPoints, SETTLEMENT.decimals).toString(),
    tier: 'T2',
    label: `${totalPoints} points of work in total`,
  },
  {
    kind: 'per_action_cap',
    value: settlementForPoints(perTaskPoints, SETTLEMENT.decimals).toString(),
    tier: 'T2',
    label: `${perTaskPoints} points on any one thing`,
  },
]

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_agents',
    description:
      'Find agents on the registry with what AiKi measured about each. Note this searches the NAME ' +
      'an agent registered, and names here rarely describe what an agent does, so a miss usually ' +
      'means "nothing is named that" rather than "there are none".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match against agent names.' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'agent_passport',
    description:
      'Everything AiKi measured about one agent: liveness, proof score with its sample size and ' +
      'confidence interval, registration checks, risks.',
    input_schema: {
      type: 'object',
      properties: { agent_id: { type: 'string' } },
      required: ['agent_id'],
    },
  },
  {
    name: 'ecosystem_stats',
    description:
      'How much of the registry AiKi has indexed and probed, and how those probes came out. Use ' +
      'this to judge how much any single score is worth.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'preview_limits',
    description:
      'What a set of limits would be worth before creating anything: which are held by a contract ' +
      'on chain and which are only counted by AiKi. Creates nothing.',
    input_schema: {
      type: 'object',
      properties: {
        per_action_usdt: { type: 'number' },
        total_usdt: { type: 'number' },
        expires_in_days: { type: 'number' },
      },
      required: ['per_action_usdt', 'total_usdt'],
    },
  },
  {
    name: 'my_account',
    description: 'The account this person’s mandates spend from, if they have one.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_mandate',
    description:
      'Create the limits an agent will work under. Deploys the account the value is spent from if ' +
      'there is not one. IMPORTANT: this does NOT sign the mandate — signing needs the person’s ' +
      'wallet, which you do not have. Tell them to sign it, and say plainly that until they do, ' +
      'the limits are counted by AiKi rather than held by the chain.',
    input_schema: {
      type: 'object',
      properties: {
        per_action_usdt: { type: 'number' },
        total_usdt: { type: 'number' },
        expires_in_days: { type: 'number' },
      },
      required: ['per_action_usdt', 'total_usdt'],
    },
  },
  {
    name: 'hire',
    description: 'Start a job under a mandate. Spends nothing on its own.',
    input_schema: {
      type: 'object',
      properties: { mandate_id: { type: 'string' } },
      required: ['mandate_id'],
    },
  },
  {
    name: 'watch_position',
    description:
      'Put the agent on duty: it checks the position on a timer and repays under the mandate ' +
      'without waiting for anyone. This is the only tool that causes money to move while nobody ' +
      'is asking, so ASK THE PERSON FIRST. It refuses an unsigned or uncapped mandate.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        minimum_health_factor: { type: 'string', description: 'e.g. "1.25". Higher acts earlier.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'watch_status',
    description: 'When the agent last looked, when it last acted, and what it decided last pass.',
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'stop_watching',
    description: 'Take the agent off duty. Free and immediate.',
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'job_record',
    description: 'Every verdict recorded against a job, refusals included.',
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'revoke_mandate',
    description: 'Stop a mandate. Nothing acts under it afterwards. Free and immediate.',
    input_schema: {
      type: 'object',
      properties: { mandate_id: { type: 'string' } },
      required: ['mandate_id'],
    },
  },
  {
    name: 'create_spending_mandate',
    description:
      'Create a mandate for BUYING work through AiKi, which is a different pot from a mandate ' +
      'for acting on chain and cannot be substituted for one. Required before posting a task. ' +
      'Amounts are in POINTS, the same unit a task price is in, so a mandate for one 500 point ' +
      'task is total 500.',
    input_schema: {
      type: 'object',
      properties: {
        total: {
          type: 'number',
          description: 'Most that may be spent on work in total, in points.',
        },
        per_task: {
          type: 'number',
          description: 'Most that may be spent on any one task, in points.',
        },
        expires_in_days: { type: 'number' },
      },
      required: ['total', 'per_task'],
    },
  },
  {
    name: 'open_tasks',
    description:
      'Work other people have posted and funded, that anybody may claim. Also returns the list ' +
      'of kinds a task may be, which is an allowlist: anything not on it cannot be asked for.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'post_task',
    description:
      'Pay for work you cannot do yourself, to be done by whoever claims it, INCLUDING A HUMAN. ' +
      'Use this when the thing needed is judgement, local knowledge, or anything no listed agent ' +
      'measurably does. The money is taken now and held until you accept what comes back, so ask ' +
      'the person you are acting for before spending theirs. Say in the brief what "done" looks ' +
      'like, because whoever claims it can only work from that sentence.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        brief: {
          type: 'string',
          description: 'What is wanted and how the result will be judged.',
        },
        kind: {
          type: 'string',
          description:
            'One of: research, review, writing, data, translation, design, code, verify. ' +
            'Call open_tasks to see what each means.',
        },
        price_points: { type: 'number', description: 'What the person doing it is paid.' },
        work_hours: {
          type: 'number',
          description:
            'How long whoever claims it has to hand it in, before the work goes back on the ' +
            'board. Default 48. Match it to the size of the job.',
        },
        mandate_id: {
          type: 'string',
          description: 'A spending mandate. The cost counts against its limits.',
        },
      },
      required: ['title', 'brief', 'kind', 'price_points', 'mandate_id'],
    },
  },
  {
    name: 'my_tasks',
    description: 'Work you posted and work you claimed, with what state each is in.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'accept_task',
    description:
      'Accept work handed in on a task you posted, which pays whoever did it out of the money ' +
      'already held. Read the submission first and say what it contains before doing this: it is ' +
      'the moment somebody is paid, and it cannot be undone.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'decline_task',
    description:
      'Say work handed in is not what was asked for. This does NOT refund: somebody did the ' +
      'work, and the money stays held while the disagreement stands. AiKi does not resolve ' +
      'disputes yet, so say that plainly rather than implying somebody will arbitrate.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, because: { type: 'string' } },
      required: ['task_id', 'because'],
    },
  },
  {
    name: 'claim_task',
    description:
      'Take a task from the board and commit to doing it. The money is already held, so it is ' +
      'there whether or not the poster changes their mind.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'release_task',
    description:
      'Take payment for work you handed in that the poster never answered. Only works once the ' +
      'review window has passed. A poster who declined has answered, and this will not override ' +
      'that.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'submit_task',
    description: 'Hand in work on a task you claimed. Once, so make it the finished thing.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, submission: { type: 'string' } },
      required: ['task_id', 'submission'],
    },
  },
]

/** Tools that change something. Named so the runner can say what it is about to do. */
export const MUTATING = new Set([
  'create_mandate',
  'create_spending_mandate',
  'hire',
  'watch_position',
  'stop_watching',
  'revoke_mandate',
  // Everything that moves money on the task board. `accept_task` most of all:
  // it is the moment a person is paid and there is no route back from it.
  'post_task',
  'claim_task',
  'submit_task',
  'accept_task',
  'decline_task',
  'release_task',
])

export async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const call = async (path: string, init: RequestInit = {}): Promise<ToolCallResult> => {
    const res = await fetch(`${ctx.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        cookie: ctx.cookie,
        ...init.headers,
      },
    })
    const raw = await res.text()
    const body = raw ? JSON.parse(raw) : null
    /*
     * A refusal is returned to the model, not thrown. The API's refusals are
     * written as sentences a person can act on, and the useful thing for a model
     * that has just been told "this mandate has not been signed" is to say so
     * and offer to fix it — not to see an exception and give up.
     */
    return { ok: res.ok, body }
  }
  const post = (path: string, body?: unknown, headers?: Record<string, string>) =>
    call(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(headers ? { headers } : {}),
    })

  switch (name) {
    case 'search_agents':
      return post('/v1/search', {
        ...(args.query ? { query: args.query } : {}),
        limit: Math.min(Number(args.limit ?? 8), 25),
      })
    case 'agent_passport':
      return call(`/v1/agents/${encodeURIComponent(String(args.agent_id))}/passport`)
    case 'ecosystem_stats':
      return call('/v1/stats')
    case 'preview_limits':
      return post('/v1/mandates/preview', {
        constraints: guardianConstraints(
          Number(args.per_action_usdt),
          Number(args.total_usdt),
          Number(args.expires_in_days ?? 30),
        ),
      })
    case 'my_account':
      return call('/v1/account')
    case 'create_mandate': {
      const account = await call('/v1/account')
      const held = (account.body as { address?: string } | null)?.address
      if (!held) await post('/v1/account')
      return post('/v1/authorizations', {
        constraints: guardianConstraints(
          Number(args.per_action_usdt),
          Number(args.total_usdt),
          Number(args.expires_in_days ?? 30),
        ),
      })
    }
    case 'hire':
      return post(
        '/v1/jobs',
        { authorizationId: args.mandate_id },
        { 'idempotency-key': `fast-${crypto.randomUUID()}` },
      )
    case 'watch_position': {
      const account = await call('/v1/account')
      const address = (account.body as { address?: string } | null)?.address
      if (!address)
        return {
          ok: false,
          body: { error: { message: 'No mandate account yet; create a mandate first.' } },
        }
      return post(`/v1/jobs/${args.job_id}/watch`, {
        account: address,
        chainId: 97,
        minimumHealthFactor: String(args.minimum_health_factor ?? '1.25'),
        asset: VENUS.asset,
        market: VENUS.market,
      })
    }
    case 'create_spending_mandate':
      return post('/v1/authorizations', {
        constraints: spendingConstraints(
          Number(args.total),
          Number(args.per_task),
          Number(args.expires_in_days ?? 30),
        ),
      })
    case 'open_tasks':
      return call('/v1/tasks')
    case 'my_tasks':
      return call('/v1/tasks/mine')
    case 'post_task':
      return post('/v1/tasks', {
        title: args.title,
        brief: args.brief,
        kind: args.kind,
        pricePoints: Math.trunc(Number(args.price_points)),
        ...(args.work_hours ? { workHours: Math.trunc(Number(args.work_hours)) } : {}),
        authorizationId: args.mandate_id,
      })
    case 'claim_task':
      return post(`/v1/tasks/${args.task_id}/claim`)
    case 'submit_task':
      return post(`/v1/tasks/${args.task_id}/submit`, { submission: args.submission })
    case 'accept_task':
      return post(`/v1/tasks/${args.task_id}/accept`)
    case 'release_task':
      return post(`/v1/tasks/${args.task_id}/release`)
    case 'decline_task':
      return post(`/v1/tasks/${args.task_id}/decline`, { because: args.because })
    case 'watch_status':
      return call(`/v1/jobs/${args.job_id}/watch`)
    case 'stop_watching':
      return post(`/v1/jobs/${args.job_id}/watch/stop`)
    case 'job_record':
      return call(`/v1/jobs/${args.job_id}`)
    case 'revoke_mandate':
      return post(`/v1/authorizations/${args.mandate_id}/revoke`)
    default:
      return { ok: false, body: { error: { message: `No such tool: ${name}` } } }
  }
}
