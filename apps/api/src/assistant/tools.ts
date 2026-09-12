import {
  actionMandateConstraints,
  amountUnits,
  type ExecutionNetwork,
  guardianConstraints,
  parseExecutionNetwork,
  tokenFor,
} from '@aiki/contracts'
import type Anthropic from '@anthropic-ai/sdk'
import { CATALOG_TOOLS, runCatalogTool } from '../catalog/assistant-tools.js'
import { settlementForPoints } from '../credits/pricing.js'
import { erc20TransferCall } from '../execution/executor.js'
import { SETTLEMENT } from '../settlement/pricing.js'
import { type MandateContinuation, mandateContinuation } from './continuation.js'
import { withDiscoveryEvidence } from './discovery-evidence.js'
import { runStrategyTool, STRATEGY_TOOLS } from './strategy-tools.js'

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
  /** Accepted SIWE address from the route, never model-supplied. */
  sessionAddress?: string
  turnId?: string
  toolCallId?: string
}

export interface ToolCallResult {
  ok: boolean
  body: unknown
  action?: MandateContinuation
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const refused = (code: string, message: string): ToolCallResult => ({
  ok: false,
  body: { error: { code, message } },
})

/** Null means malformed; an explicit null address means no account exists yet. */
function mandateAccount(value: unknown, chainId: number): { address: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const account = value as Record<string, unknown>
  if (account.chainId !== chainId) return null
  if (account.address === null) return { address: null }
  if (
    typeof account.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(account.address) ||
    /^0x0{40}$/.test(account.address)
  )
    return null
  return { address: account.address }
}

const unverifiedAccount = () =>
  refused(
    'EXECUTION_ACCOUNT_UNVERIFIED',
    'The mandate account could not be verified on the configured execution network. No mandate or watch was started.',
  )

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
  ...CATALOG_TOOLS,
  ...STRATEGY_TOOLS,
  {
    name: 'agent_task_support',
    description:
      'Check whether a specific agent currently accepts AiKi tasks before offering to hire it. Returns availability, input guidance when declared, minimum buyer offer and the platform fee. This checks AiKi task integration, not every capability the provider offers elsewhere.',
    input_schema: {
      type: 'object',
      properties: { agent_id: { type: 'string' } },
      required: ['agent_id'],
    },
  },
  {
    name: 'search_agents',
    description:
      'Search names and descriptions in the part of the registry AiKi has indexed. Results include measured data, not a guarantee that an agent accepts work. A miss does not mean no such agent exists on BNB Chain.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to match against indexed agent names and descriptions.',
        },
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
      'AiKi index and probe coverage, not a census of working BNB agents. probed.byState includes stale last verdicts; probed.currentByState contains fresh checks. Missing fresh data is unknown, not zero or provider failure.',
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
    description:
      'The account this person’s mandates spend from, if they have one, and what it holds. ' +
      '`balances` gives native BNB in wei and each token in base units; read `decimals` before ' +
      'stating any amount. `balances: null` means the chain could not be read, which is NOT the ' +
      'same as empty, so say it is unknown rather than reporting zero. An agent can only ever ' +
      'spend tokens from this account, never native BNB, so an account holding only BNB has ' +
      'nothing an agent can use and needs USDT sent to its address.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_mandate',
    description:
      'Create the limits an agent will work under. Deploys the account the value is spent from if ' +
      'there is not one. IMPORTANT: this does NOT sign the mandate - signing needs the person’s ' +
      'wallet, which you do not have. Tell them to use the Review and sign control in this chat. ' +
      'Do not create another mandate to complete signing. No job or watch is started by signing.',
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
    name: 'create_action_mandate',
    description:
      'Create limits that let an agent move ONE token to addresses you name. Different from ' +
      'create_mandate, which only ever permits repaying a Venus loan. The token, the contract, ' +
      'the function and both caps are held by contracts on chain. The destination list is held ' +
      'by AiKi, which reads it out of the call and refuses to relay anything else; say that ' +
      'plainly and never call the destination rule chain-enforced. Like create_mandate this does ' +
      'NOT sign: tell them to use the Review and sign control. Naming no destination is refused, ' +
      'because a token mandate with no destination lets the full cap go anywhere.',
    input_schema: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          description: 'Symbol, for example USDT. Ask my_account for what this network holds.',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Addresses the agent may send to. Required, at least one, at most 32.',
        },
        can: {
          type: 'array',
          items: { type: 'string', enum: ['send', 'approve'] },
          description: 'send permits transfer. approve permits letting a contract take the token.',
        },
        per_action: {
          type: 'number',
          description: 'Most it may move in one action, in whole tokens.',
        },
        total: { type: 'number', description: 'Most it may move in total, in whole tokens.' },
        expires_in_days: { type: 'number' },
      },
      required: ['token', 'to', 'can', 'per_action', 'total'],
    },
  },
  {
    name: 'send_token',
    description:
      'Move tokens out of the spending account under a signed mandate, to an address that ' +
      'mandate names. This is the one tool that actually moves money on chain, so state the ' +
      'amount, the token and the destination and get explicit agreement before calling it. ' +
      'Needs a job started from a SIGNED action mandate. AiKi checks the mandate first and the ' +
      'chain checks it again; a refusal from either is a real answer worth reporting, including ' +
      'which rule refused. Never call this to "test" anything.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'A job started under the action mandate.' },
        token: { type: 'string', description: 'Symbol, for example USDT.' },
        to: { type: 'string', description: 'Destination address. Must be one the mandate names.' },
        amount: { type: 'number', description: 'Whole tokens, not base units.' },
        why: { type: 'string', description: 'One line, shown to the person and stored.' },
      },
      required: ['job_id', 'token', 'to', 'amount'],
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
    name: 'hire_agent',
    description:
      'Pay one named agent from the registry to do a discrete piece of work, and send it the ' +
      'brief. Different from watching a position: this asks for an answer, once. The agent is ' +
      'called at the endpoint its registration declares, and most agents on this registry do not ' +
      'answer, which is normal and is why the money comes back if it does not. Check the ' +
      'passport first and say what was measured about it before spending. Some agents are ' +
      'reached over MCP and advertise several named capabilities; for those, agent_task_support ' +
      'lists them and you must name one in agent_tool.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        title: { type: 'string' },
        brief: { type: 'string', description: 'What is wanted and how it will be judged.' },
        kind: { type: 'string', description: 'One of the kinds open_tasks lists.' },
        price_points: { type: 'number' },
        work_hours: { type: 'number', description: 'How long it has to answer. Default 48.' },
        mandate_id: { type: 'string', description: 'A spending mandate.' },
        agent_tool: {
          type: 'string',
          description:
            'Which capability of the agent to pay for. Required whenever agent_task_support ' +
            'returns toolRequired, and it must be one of the names in the tools it listed. Read ' +
            'the descriptions, say which one you are buying and what it does, and get agreement ' +
            'before buying it.',
        },
      },
      required: ['agent_id', 'title', 'brief', 'kind', 'price_points', 'mandate_id'],
    },
  },
  {
    name: 'find_people',
    description:
      'People listed as available for work, with what each has actually delivered here. The ' +
      'record is counted from settled work, never entered by them, so a listing with nothing ' +
      'beside it is somebody new rather than somebody bad. Use this when the job needs judgement ' +
      'or local knowledge that no measured agent does.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'hire_person',
    description:
      'Pay one listed person to do a discrete piece of work. The money is held immediately and ' +
      'comes back if they do not hand anything in before the deadline. Nothing is sent anywhere: ' +
      'they see it in their own list. Ask the person you act for before spending their money.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'The seller, by address.' },
        title: { type: 'string' },
        brief: { type: 'string', description: 'What is wanted and how it will be judged.' },
        kind: { type: 'string' },
        price_points: { type: 'number' },
        work_hours: { type: 'number' },
        mandate_id: { type: 'string', description: 'A spending mandate.' },
      },
      required: ['address', 'title', 'brief', 'kind', 'price_points', 'mandate_id'],
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
  'create_action_mandate',
  // The only tool that moves a token out of the spending account.
  'send_token',
  'create_spending_mandate',
  'hire',
  'watch_position',
  'stop_watching',
  'revoke_mandate',
  // Everything that moves money on the task board. `accept_task` most of all:
  // it is the moment a person is paid and there is no route back from it.
  'post_task',
  'hire_agent',
  'hire_person',
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
  const operationKey =
    ctx.turnId && ctx.toolCallId
      ? `fast:${ctx.turnId}:${ctx.toolCallId}`
      : `fast:${crypto.randomUUID()}`
  const call = async (path: string, init: RequestInit = {}): Promise<ToolCallResult> => {
    const res = await fetch(`${ctx.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        cookie: ctx.cookie,
        ...init.headers,
        ...(ctx.sessionAddress ? { 'x-aiki-wallet-address': ctx.sessionAddress } : {}),
      },
    })
    const raw = await res.text()
    const body = raw ? JSON.parse(raw) : null
    /*
     * A refusal is returned to the model, not thrown. The API's refusals are
     * written as sentences a person can act on, and the useful thing for a model
     * that has just been told "this mandate has not been signed" is to say so
     * and offer to fix it - not to see an exception and give up.
     */
    return { ok: res.ok, body }
  }
  const post = (path: string, body?: unknown, headers?: Record<string, string>) =>
    call(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(headers ? { headers } : {}),
    })

  const executionNetwork = async (): Promise<
    { network: ExecutionNetwork } | { error: ToolCallResult }
  > => {
    // Configuration is read afresh, never inferred from the wallet, billing
    // rail, prompt, or tool arguments. Action readiness remains the API's job.
    try {
      const result = await call('/v1/execution/network', { cache: 'no-store' })
      if (!result.ok) return { error: result }
      return { network: parseExecutionNetwork(result.body) }
    } catch {
      return {
        error: refused(
          'EXECUTION_NETWORK_UNVERIFIED',
          'The configured execution network could not be verified. No action was started. Try again later.',
        ),
      }
    }
  }
  const accountRequest = async (deploy = false): Promise<ToolCallResult> => {
    try {
      return await (deploy ? post('/v1/account') : call('/v1/account'))
    } catch {
      // A deployment request may have reached the API before its response was
      // lost. Do not claim nothing was created or continue to authorize.
      return refused(
        'EXECUTION_ACCOUNT_UNVERIFIED',
        'The mandate account could not be confirmed. No mandate or watch was started. Check your account before trying again.',
      )
    }
  }

  const catalog = await runCatalogTool(name, args, ctx.sessionAddress, (path, body) =>
    body === undefined ? call(path) : post(path, body),
  )
  if (catalog) return withDiscoveryEvidence(name, catalog)
  const strategy = await runStrategyTool(name, args, ctx.sessionAddress, (path) =>
    call(path, { cache: 'no-store' }),
  )
  if (strategy) return strategy

  switch (name) {
    case 'agent_task_support':
      return withDiscoveryEvidence(
        name,
        await call(`/v1/agents/${encodeURIComponent(String(args.agent_id))}/task-support`),
      )
    case 'search_agents':
      return withDiscoveryEvidence(
        name,
        await post('/v1/search', {
          ...(args.query ? { query: args.query } : {}),
          limit: Math.min(Number(args.limit ?? 8), 25),
        }),
      )
    case 'agent_passport':
      return withDiscoveryEvidence(
        name,
        await call(`/v1/agents/${encodeURIComponent(String(args.agent_id))}/passport`),
      )
    case 'ecosystem_stats':
      return withDiscoveryEvidence(name, await call('/v1/stats'))
    case 'preview_limits':
    case 'create_mandate': {
      const execution = await executionNetwork()
      if ('error' in execution) return execution.error
      const { chainId } = execution.network
      let constraints: ReturnType<typeof guardianConstraints>
      try {
        constraints = guardianConstraints({
          chainId,
          perActionUsdt:
            typeof args.per_action_usdt === 'number' ? args.per_action_usdt : Number.NaN,
          totalUsdt: typeof args.total_usdt === 'number' ? args.total_usdt : Number.NaN,
          expiresInDays:
            args.expires_in_days === undefined
              ? 30
              : typeof args.expires_in_days === 'number'
                ? args.expires_in_days
                : Number.NaN,
        })
      } catch (error) {
        // The shared parser's errors contain only fixed validation guidance.
        return refused(
          'GUARDIAN_LIMITS_INVALID',
          error instanceof Error ? error.message : 'Choose valid USDT limits and an expiry.',
        )
      }
      if (name === 'preview_limits') return post('/v1/mandates/preview', { constraints })

      // Validate limits before even requesting an account deployment.
      const account = await accountRequest()
      if (!account.ok) return account
      const held = mandateAccount(account.body, chainId)
      if (!held) return unverifiedAccount()
      let accountAddress = held.address
      if (accountAddress === null) {
        const deployment = await accountRequest(true)
        if (!deployment.ok) return deployment
        accountAddress = mandateAccount(deployment.body, chainId)?.address ?? null
        if (!accountAddress) return unverifiedAccount()
      }
      const created = await post('/v1/authorizations', { constraints })
      const authorization = created.body as { id?: unknown; owner?: unknown } | null
      const action =
        created.ok &&
        typeof authorization?.owner === 'string' &&
        authorization.owner.toLowerCase() === ctx.sessionAddress?.toLowerCase()
          ? mandateContinuation({
              kind: 'sign_mandate',
              authorizationId: authorization.id,
              chainId,
              account: accountAddress,
              manager: execution.network.manager,
            })
          : undefined
      return { ...created, ...(action ? { action } : {}) }
    }
    case 'create_action_mandate': {
      const execution = await executionNetwork()
      if ('error' in execution) return execution.error
      const { chainId } = execution.network
      let constraints: ReturnType<typeof actionMandateConstraints>
      try {
        constraints = actionMandateConstraints({
          chainId,
          symbol: typeof args.token === 'string' ? args.token : '',
          recipients: Array.isArray(args.to) ? args.to.map((entry) => String(entry)) : [],
          can: (Array.isArray(args.can) ? args.can : []).map((entry) => String(entry)) as (
            | 'send'
            | 'approve'
          )[],
          perAction: typeof args.per_action === 'number' ? args.per_action : Number.NaN,
          total: typeof args.total === 'number' ? args.total : Number.NaN,
          expiresInDays:
            args.expires_in_days === undefined
              ? 30
              : typeof args.expires_in_days === 'number'
                ? args.expires_in_days
                : Number.NaN,
        })
      } catch (error) {
        // Builder errors are fixed validation guidance, safe to relay verbatim.
        return refused(
          'ACTION_MANDATE_INVALID',
          error instanceof Error
            ? error.message
            : 'Choose a reviewed token, a destination and valid limits.',
        )
      }
      const account = await accountRequest()
      if (!account.ok) return account
      const held = mandateAccount(account.body, chainId)
      if (!held) return unverifiedAccount()
      let accountAddress = held.address
      if (accountAddress === null) {
        const deployment = await accountRequest(true)
        if (!deployment.ok) return deployment
        accountAddress = mandateAccount(deployment.body, chainId)?.address ?? null
        if (!accountAddress) return unverifiedAccount()
      }
      const created = await post('/v1/authorizations', { constraints })
      const authorization = created.body as { id?: unknown; owner?: unknown } | null
      const action =
        created.ok &&
        typeof authorization?.owner === 'string' &&
        authorization.owner.toLowerCase() === ctx.sessionAddress?.toLowerCase()
          ? mandateContinuation({
              kind: 'sign_mandate',
              // A different shape from the guardian one, so the review screen
              // checks it against what this builder actually produced rather
              // than against the Venus scope.
              scope: 'token_transfer',
              authorizationId: authorization.id,
              chainId,
              account: accountAddress,
              manager: execution.network.manager,
            })
          : undefined
      return { ...created, ...(action ? { action } : {}) }
    }
    case 'send_token': {
      const execution = await executionNetwork()
      if ('error' in execution) return execution.error
      const { chainId } = execution.network
      let token: ReturnType<typeof tokenFor>
      let amount: string
      let to: string
      try {
        token = tokenFor(chainId, typeof args.token === 'string' ? args.token : '')
        amount = amountUnits(
          typeof args.amount === 'number' ? args.amount : Number.NaN,
          token.decimals,
          token.symbol,
        )
        const candidate = typeof args.to === 'string' ? args.to.toLowerCase() : ''
        if (!/^0x[0-9a-f]{40}$/.test(candidate) || /^0x0+$/.test(candidate))
          throw new Error('Give a destination address the mandate names.')
        to = candidate
      } catch (error) {
        return refused(
          'SEND_INVALID',
          error instanceof Error
            ? error.message
            : 'Choose a reviewed token, a destination and an amount.',
        )
      }
      if (typeof args.job_id !== 'string' || !UUID.test(args.job_id))
        return refused(
          'SEND_INVALID',
          'Give the id of a job started under a signed action mandate.',
        )
      /*
       * The calldata is built here from named parts, never supplied by the
       * model. An amount the model states and calldata the model writes are two
       * different numbers, and the one the chain executes is the calldata.
       */
      return post(`/v1/jobs/${args.job_id}/actions`, {
        target: token.address,
        selector: '0xa9059cbb',
        asset: token.address,
        amount,
        callData: erc20TransferCall(to as `0x${string}`, BigInt(amount)),
        ...(typeof args.why === 'string' ? { why: args.why.slice(0, 300) } : {}),
      })
    }
    case 'my_account':
      return call('/v1/account')
    case 'hire':
      return post(
        '/v1/jobs',
        { authorizationId: args.mandate_id },
        { 'idempotency-key': operationKey },
      )
    case 'watch_position': {
      const execution = await executionNetwork()
      if ('error' in execution) return execution.error
      const { chainId, guardian } = execution.network
      const account = await accountRequest()
      if (!account.ok) return account
      const held = mandateAccount(account.body, chainId)
      if (!held) return unverifiedAccount()
      const { address } = held
      if (!address)
        return {
          ok: false,
          body: { error: { message: 'No mandate account yet; create a mandate first.' } },
        }
      return post(`/v1/jobs/${args.job_id}/watch`, {
        account: address,
        chainId,
        minimumHealthFactor: String(args.minimum_health_factor ?? '1.25'),
        asset: guardian.asset,
        market: guardian.market,
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
      return post(
        '/v1/tasks',
        {
          title: args.title,
          brief: args.brief,
          kind: args.kind,
          pricePoints: Math.trunc(Number(args.price_points)),
          ...(args.work_hours ? { workHours: Math.trunc(Number(args.work_hours)) } : {}),
          authorizationId: args.mandate_id,
        },
        { 'idempotency-key': operationKey },
      )
    case 'hire_agent':
      return post(
        '/v1/tasks',
        {
          title: args.title,
          brief: args.brief,
          kind: args.kind,
          pricePoints: Math.trunc(Number(args.price_points)),
          ...(args.work_hours ? { workHours: Math.trunc(Number(args.work_hours)) } : {}),
          authorizationId: args.mandate_id,
          assignAgentId: args.agent_id,
          ...(typeof args.agent_tool === 'string' && args.agent_tool
            ? { agentTool: args.agent_tool }
            : {}),
        },
        { 'idempotency-key': operationKey },
      )
    case 'find_people':
      return call('/v1/sellers')
    case 'hire_person':
      return post(
        '/v1/tasks',
        {
          title: args.title,
          brief: args.brief,
          kind: args.kind,
          pricePoints: Math.trunc(Number(args.price_points)),
          ...(args.work_hours ? { workHours: Math.trunc(Number(args.work_hours)) } : {}),
          authorizationId: args.mandate_id,
          hirePerson: args.address,
        },
        { 'idempotency-key': operationKey },
      )
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
