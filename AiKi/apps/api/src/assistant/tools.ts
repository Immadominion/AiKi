import type Anthropic from '@anthropic-ai/sdk'

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
]

/** Tools that change something. Named so the runner can say what it is about to do. */
export const MUTATING = new Set([
  'create_mandate',
  'hire',
  'watch_position',
  'stop_watching',
  'revoke_mandate',
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
