import type Anthropic from '@anthropic-ai/sdk'
import type { ToolCallResult } from './tools.js'

const KINDS = ['yield', 'grid', 'lp'] as const
type Kind = (typeof KINDS)[number]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i,
  HASH = /^0x[0-9a-f]{64}$/i
const address = (value: unknown): value is string =>
  typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/.test(value)
const hash = (value: unknown): value is string =>
  typeof value === 'string' && HASH.test(value) && !/^0x0{64}$/.test(value)
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid strategy data.')
  return value as Record<string, unknown>
}
const kind = (value: unknown): value is Kind => KINDS.includes(value as Kind)
const text = (value: unknown, limit = 300) =>
  typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').slice(0, limit) : ''
const refuse = (code: string, message: string): ToolCallResult => ({
  ok: false,
  body: { error: { code, message } },
})
const notice =
  'Navigation and status only. Deployment, approval, funding or enrollment, mandate signing, onchain enablement and scheduler start are separate explicit owner actions on the setup page. No action was submitted.'

export const STRATEGY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'strategy_config',
    description:
      'Read current deployment-verified BNB mainnet strategy availability and the exact configured first-party registry identities. This is not owner readiness or permission to execute. Creates nothing.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'strategy_setup_link',
    description:
      'Get a safe navigation link to the Yield, Grid or LP wallet setup page only after the exact configured first-party registry identity matches its current live reciprocal passport. Reports remain separate purchases. The link deploys, funds, signs and starts nothing; unavailable deployments remain explicitly unavailable.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: KINDS } },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'my_strategies',
    description:
      'Read a bounded list of the signed-in owner’s existing strategy setups and recorded scheduler states. Never infer a transaction or profit from ACTIVE. Creates or starts nothing.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'strategy_status',
    description:
      'Read fresh readiness and recorded activity for one existing setup owned by this session. Use its real setup_id, not a job or mandate ID. Does not resume, recover, sign or send anything.',
    input_schema: {
      type: 'object',
      properties: { setup_id: { type: 'string', pattern: UUID.source } },
      required: ['setup_id'],
      additionalProperties: false,
    },
  },
]
type Read = (path: string) => Promise<ToolCallResult>
interface Identity {
  agentId: string
  registry: string
  chainId: 56
}
interface Config {
  available: boolean
  schedulerReady: boolean
  agents: Partial<Record<Kind, Identity>>
}
async function config(read: Read): Promise<Config> {
  const response = await read('/v1/strategies/config')
  if (!response.ok) throw new Error('Unavailable configuration.')
  const body = object(response.body)
  if (body.chainId !== 56 || typeof body.available !== 'boolean')
    throw new Error('Invalid configuration.')
  if (body.available) {
    if (
      !hash(body.configurationHash) ||
      !address(body.manager) ||
      !address(body.executor) ||
      !address(body.bindingEnforcer) ||
      !address(body.expiryEnforcer) ||
      typeof body.schedulerReady !== 'boolean' ||
      !Array.isArray(body.kinds) ||
      body.kinds.length !== 3 ||
      new Set(body.kinds).size !== 3 ||
      body.kinds.some((value) => !kind(value))
    )
      throw new Error('Invalid configuration.')
    const factories = object(body.factories)
    for (const k of KINDS) {
      const f = object(factories[k])
      if (!address(f.address) || !hash(f.runtimeCodeHash)) throw new Error('Invalid factory.')
    }
  }
  const agents: Config['agents'] = {}
  if (body.agents !== undefined) {
    const source = object(body.agents)
    if (Object.keys(source).some((value) => !kind(value))) throw new Error('Invalid identities.')
    for (const k of KINDS) {
      if (source[k] === undefined) continue
      const agent = object(source[k])
      if (
        agent.chainId !== 56 ||
        typeof agent.agentId !== 'string' ||
        !/^(0|[1-9][0-9]{0,77})$/.test(agent.agentId) ||
        !address(agent.registry)
      )
        throw new Error('Invalid identity.')
      agents[k] = { agentId: agent.agentId, registry: agent.registry.toLowerCase(), chainId: 56 }
    }
  }
  return {
    available: body.available,
    schedulerReady: body.available && body.schedulerReady === true,
    agents,
  }
}
function summary(value: unknown, owner: string) {
  const setup = object(value),
    ready = object(setup.readiness)
  if (
    typeof setup.id !== 'string' ||
    !UUID.test(setup.id) ||
    setup.chainId !== 56 ||
    !kind(setup.kind) ||
    typeof setup.owner !== 'string' ||
    setup.owner.toLowerCase() !== owner.toLowerCase() ||
    !['DRAFT', 'DEPLOYED', 'SIGNED', 'ACTIVE', 'PAUSED', 'NEEDS_REVIEW'].includes(
      String(setup.status),
    ) ||
    typeof ready.ready !== 'boolean' ||
    typeof ready.schedulerReady !== 'boolean' ||
    !Array.isArray(ready.reasons)
  )
    throw new Error('Invalid owner status.')
  const auth = setup.authorization === null ? null : object(setup.authorization)
  const watch = setup.watch === undefined ? null : object(setup.watch)
  const decision =
    watch?.lastDecision === null || watch?.lastDecision === undefined
      ? null
      : object(watch.lastDecision)
  return {
    setupId: setup.id,
    kind: setup.kind,
    chainId: 56,
    status: setup.status,
    mandateSigned: !!auth && typeof auth.signedAt === 'string' && hash(auth.digest),
    readiness: {
      ready: ready.ready,
      schedulerReady: ready.schedulerReady,
      reasons: ready.reasons
        .slice(0, 8)
        .map((value) => text(value))
        .filter(Boolean),
    },
    ...(watch
      ? {
          activity: {
            status: text(watch.status, 24),
            nextRunAt: text(watch.nextRunAt, 32),
            lastDecision: decision
              ? { reason: text(decision.reason), at: text(decision.at, 32) }
              : null,
            lastTransactionHash: hash(watch.lastTransactionHash) ? watch.lastTransactionHash : null,
          },
        }
      : {}),
  }
}

/** Read-only HTTP surface. No model argument becomes a URL, recipient, amount or transaction. */
export async function runStrategyTool(
  name: string,
  args: Record<string, unknown>,
  sessionAddress: string | undefined,
  read: Read,
): Promise<ToolCallResult | null> {
  if (!STRATEGY_TOOLS.some((tool) => tool.name === name)) return null
  try {
    const input = object(args),
      keys = Object.keys(input).sort().join(',')
    const expected =
      name === 'strategy_setup_link' ? 'kind' : name === 'strategy_status' ? 'setup_id' : ''
    if (
      keys !== expected ||
      (name === 'strategy_setup_link' && !kind(input.kind)) ||
      (name === 'strategy_status' &&
        (typeof input.setup_id !== 'string' || !UUID.test(input.setup_id)))
    )
      return refuse(
        'STRATEGY_ARGUMENTS_INVALID',
        'Use only the supported strategy kind or the existing setup ID. Do not provide wallet actions or owner addresses.',
      )
    if (name === 'my_strategies' || name === 'strategy_status') {
      if (!address(sessionAddress))
        return refuse('UNAUTHENTICATED', 'Sign in to read your own strategy setups.')
      const response = await read(
        name === 'my_strategies' ? '/v1/strategies' : `/v1/strategies/${input.setup_id}`,
      )
      if (!response.ok)
        return refuse(
          'STRATEGY_STATUS_UNAVAILABLE',
          'This session could not read that strategy status. Refresh your sign-in and use an existing setup you own.',
        )
      if (name === 'strategy_status')
        return { ok: true, body: { ...summary(response.body, sessionAddress), notice } }
      const body = object(response.body)
      if (!Array.isArray(body.setups)) throw new Error('Invalid setup list.')
      const setups = body.setups.slice(0, 12).map((value) => summary(value, sessionAddress))
      return { ok: true, body: { setups, hasMore: body.setups.length > 12, notice } }
    }
    const current = await config(read)
    if (name === 'strategy_config')
      return {
        ok: true,
        body: {
          chainId: 56,
          available: current.available,
          schedulerReady: current.schedulerReady,
          strategies: KINDS.map((kind) => ({
            kind,
            ...(current.agents[kind] ? { agent: current.agents[kind] } : {}),
          })),
          notice,
        },
      }
    const selected = input.kind as Kind,
      agent = current.agents[selected]
    if (!agent)
      return refuse(
        'STRATEGY_IDENTITY_UNVERIFIED',
        'No exact first-party registry identity is configured for this strategy. No setup link or action was produced.',
      )
    const response = await read(`/v1/agents/${agent.agentId}/passport`)
    if (!response.ok) throw new Error('Unverified passport.')
    const passport = object(response.body),
      registration = object(object(passport.identity).registrationFile)
    if (
      passport.agentId !== agent.agentId ||
      passport.chainId !== agent.chainId ||
      typeof passport.registry !== 'string' ||
      passport.registry.toLowerCase() !== agent.registry ||
      passport.liveness !== 'LIVE' ||
      registration.reciprocalProofVerified !== true
    )
      throw new Error('Identity changed.')
    return {
      ok: true,
      body: {
        kind: selected,
        chainId: 56,
        agent,
        available: current.available,
        schedulerReady: current.schedulerReady,
        href: `/strategy/${selected}`,
        navigationOnly: true,
        notice: current.available
          ? notice
          : `Reviewed strategy deployments are not available. This page may show setup requirements, but no strategy can start yet. ${notice}`,
      },
    }
  } catch {
    return refuse(
      'STRATEGY_READ_UNVERIFIED',
      'Current strategy configuration, identity or owner status could not be verified. No wallet action was submitted.',
    )
  }
}
