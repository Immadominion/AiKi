import type { FastifyInstance } from 'fastify'
import { type Address, isAddress, zeroAddress } from 'viem'
import { BSC_MAINNET } from '../config/chains.js'
import { DISPATCH_PROTOCOL } from '../tasks/dispatch.js'
import type { GridPolicy } from './grid/client.js'

const MAX_BRIEF_CHARS = 10_000
const HINTS = {
  rebalancer:
    'Read-only BNB mainnet LP report. Include a line: tokenId: YOUR_POSITION_NFT_ID. JSON {"tokenId":"123"} also works. No liquidity change or transaction is made.',
  grid: 'Read-only BNB mainnet grid report. Add separate lines: pool: YOUR_POOL_ADDRESS; tickLower: -100; tickUpper: 100; spacing: 10 (use your own ticks). JSON with these fields also works. No orders or transactions.',
  yield:
    'Read-only BNB mainnet supply-rate report. Add markets: YOUR_VENUS_MARKET_ADDRESS,ANOTHER_MARKET_ADDRESS (1 to 10). Optional line rateOnly: true selects the highest rate, not the safest investment. JSON also works. No funds move.',
} as const

export function reportTaskCapability(kind: keyof typeof HINTS) {
  return {
    taskProtocol: DISPATCH_PROTOCOL,
    taskInputHint: HINTS[kind],
    taskKinds: ['research', 'data', 'verify'],
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected fields.')
  return value as Record<string, unknown>
}

/** A brief carries explicit parameters, not instructions executed by a model. */
function fields(brief: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof brief !== 'string' || !brief.trim() || brief.length > MAX_BRIEF_CHARS)
    throw new Error('Invalid brief.')
  const text = brief.trim()
  let values: Record<string, unknown>
  if (text.startsWith('{')) values = object(JSON.parse(text))
  else if (text.includes('```')) {
    const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)]
    const body = blocks[0]?.[1]
    if (blocks.length !== 1 || text.split('```').length !== 3 || body === undefined)
      throw new Error('Ambiguous inputs.')
    values = object(JSON.parse(body))
  } else {
    values = Object.create(null) as Record<string, unknown>
    // Allow a normal request above the labeled lines. Values must stay explicit.
    for (const line of text.split(/[\n;]/)) {
      const match = line.match(/^\s*(\w+)\s*[:=]\s*(.*?)\s*$/)
      const key = match?.[1]
      const raw = match?.[2]
      if (!key || raw === undefined || ![...allowed, 'chainId'].includes(key)) continue
      if (Object.hasOwn(values, key)) throw new Error('Duplicate input.')
      if (key === 'tokenId' && /^\d+$/.test(raw)) values[key] = raw
      else if (key === 'markets' && !raw.startsWith('['))
        values[key] = raw.split(',').map((x) => x.trim())
      else {
        try {
          values[key] = JSON.parse(raw)
        } catch {
          values[key] = raw
        }
      }
    }
  }
  if (Object.keys(values).some((key) => ![...allowed, 'chainId'].includes(key)))
    throw new Error('Unsupported input.')
  if (values.chainId !== undefined && values.chainId !== BSC_MAINNET.id)
    throw new Error('This reader only supports BNB mainnet.')
  return values
}

function address(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || value === zeroAddress)
    throw new Error('Invalid contract address.')
  return value as Address
}

export const reportInputs = {
  rebalancer(brief: unknown): string {
    const { tokenId } = fields(brief, ['tokenId'])
    const value =
      typeof tokenId === 'number' && Number.isSafeInteger(tokenId) ? String(tokenId) : tokenId
    if (typeof value !== 'string' || !/^\d{1,78}$/.test(value) || BigInt(value) >= 2n ** 256n)
      throw new Error('Invalid position NFT id.')
    return value
  },
  grid(brief: unknown): GridPolicy {
    const input = fields(brief, ['pool', 'tickLower', 'tickUpper', 'spacing'])
    const pool = address(input.pool)
    const { tickLower, tickUpper, spacing } = input
    if (
      typeof tickLower !== 'number' ||
      typeof tickUpper !== 'number' ||
      typeof spacing !== 'number' ||
      !Number.isSafeInteger(tickLower) ||
      !Number.isSafeInteger(tickUpper) ||
      !Number.isSafeInteger(spacing) ||
      tickLower < -887272 ||
      tickUpper > 887272 ||
      tickLower >= tickUpper ||
      spacing <= 0 ||
      (tickUpper - tickLower) % spacing !== 0
    )
      throw new Error('Invalid grid bounds.')
    return { pool, tickLower, tickUpper, spacing }
  },
  yield(brief: unknown): { markets: Address[]; rateOnly: boolean } {
    const input = fields(brief, ['markets', 'rateOnly'])
    if (
      !Array.isArray(input.markets) ||
      input.markets.length < 1 ||
      input.markets.length > 10 ||
      (input.rateOnly !== undefined && typeof input.rateOnly !== 'boolean')
    )
      throw new Error('Invalid market inputs.')
    const markets = input.markets.map(address)
    if (new Set(markets.map((market) => market.toLowerCase())).size !== markets.length)
      throw new Error('Duplicate market.')
    return { markets, rateOnly: input.rateOnly === true }
  },
}

interface ReportAssessment {
  observedAt: string
  assessmentVersion: string
  caveats: string[]
}

/** Synchronous task delivery. Callback addresses and tokens are never used by these read-only agents. */
export function registerReportTask<Input, Assessment extends ReportAssessment>(
  app: FastifyInstance,
  options: {
    path: string
    agentId: string | undefined
    kind: keyof typeof HINTS
    title: string
    parse(brief: unknown): Input
    read(input: Input): Promise<Assessment>
    persist(assessment: NoInfer<Assessment>): Promise<boolean>
    summary(assessment: NoInfer<Assessment>): string[]
  },
) {
  app.post<{
    Params: { agentId: string }
    Body: { protocol?: unknown; agentId?: unknown; brief?: unknown }
  }>(`${options.path}/:agentId`, async (request, reply) => {
    if (!options.agentId || request.params.agentId !== options.agentId)
      return reply
        .code(404)
        .send({ error: 'This endpoint only serves its configured agent identity.' })
    if (request.body?.protocol !== DISPATCH_PROTOCOL)
      return reply.code(400).send({ error: 'This endpoint speaks aiki.task/v1.' })
    if (request.body.agentId !== undefined && request.body.agentId !== options.agentId)
      return reply.code(400).send({ error: 'The task agentId must match this endpoint.' })
    let input: Input
    try {
      input = options.parse(request.body.brief)
    } catch {
      return reply.code(400).send({ error: `Invalid report inputs. ${HINTS[options.kind]}` })
    }
    try {
      const assessment = await options.read(input)
      const persisted = await options.persist(assessment)
      const result = [
        options.title,
        'BNB Smart Chain mainnet (56). Read-only report. No trade or financial transaction was submitted.',
        ...options.summary(assessment),
        `Observed: ${assessment.observedAt}. Method: ${assessment.assessmentVersion}.`,
        ...assessment.caveats,
        persisted ? 'Assessment saved to AiKi evidence.' : 'Assessment attached below.',
        '',
        'Recorded assessment',
        '```json',
        JSON.stringify(assessment, null, 2),
        '```',
      ].join('\n')
      const delivery = { result, assessment, evidence: { persisted } }
      // The marketplace reads at most 20,000 response characters, including JSON escaping.
      if (JSON.stringify(delivery).length > 19_000)
        throw new Error('Report exceeds delivery limit.')
      return delivery
    } catch {
      // RPC URLs, credentials and database details must not reach public task responses.
      return {
        error:
          'I could not complete this report. The on-chain read or evidence record was unavailable. No transaction was submitted.',
      }
    }
  })
}
