import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'

export interface AssistantLimits {
  walletPerMinute: number
  walletDailyPoints: number
  globalDailyPoints: number
  globalConcurrent: number
  leaseSeconds: number
}

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function assistantLimits(): AssistantLimits {
  return {
    walletPerMinute: positive(process.env.FAST_WALLET_TURNS_PER_MINUTE, 6),
    walletDailyPoints: positive(process.env.FAST_WALLET_DAILY_POINTS, 100_000),
    globalDailyPoints: positive(process.env.FAST_GLOBAL_DAILY_POINTS, 1_000_000),
    globalConcurrent: positive(process.env.FAST_GLOBAL_CONCURRENT, 8),
    leaseSeconds: positive(process.env.FAST_TURN_LEASE_SECONDS, 900),
  }
}

export interface StartAssistantRequest {
  owner: string
  key: string
  requestHash: string
  reservedPoints: number
  limits: AssistantLimits
}

export type AssistantRequestClaim =
  | { kind: 'started'; id: string }
  | { kind: 'replayed'; id: string; status: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'refused'; code: string; message: string; status: 409 | 429; retryAfter?: number }

export interface AssistantRequestStore {
  begin(input: StartAssistantRequest): Promise<AssistantRequestClaim>
  checkpoint(id: string, points: number, inputTokens: number, outputTokens: number): Promise<void>
  complete(input: {
    id: string
    status: number
    body: unknown
    points: number
    uncertain?: boolean
  }): Promise<void>
}

interface RequestRow {
  id: string
  owner: string
  request_hash: string
  state: 'IN_PROGRESS' | 'COMPLETED' | 'UNCONFIRMED'
  reserved_points: number | string
  usage_points: number | string
  response_status: number | null
  response_body: unknown
  created_at: Date | string
  lease_expires_at: Date | string
}

const timestamp = (value: Date | string) => new Date(value).getTime()
const active = (row: RequestRow) => row.state !== 'COMPLETED'
// A lost provider outcome keeps its financial reservation, not a global
// execution slot forever. The original wallet stays blocked until reconciled.
const running = (row: RequestRow, now: number) =>
  row.state === 'IN_PROGRESS' && timestamp(row.lease_expires_at) > now
const accounted = (row: RequestRow) =>
  active(row)
    ? Math.max(Number(row.reserved_points), Number(row.usage_points))
    : Number(row.usage_points)

function replay(row: RequestRow, hash: string, now: number): AssistantRequestClaim {
  if (row.request_hash !== hash) return { kind: 'conflict' }
  if (row.response_status !== null)
    return { kind: 'replayed', id: row.id, status: row.response_status, body: row.response_body }
  const expired = timestamp(row.lease_expires_at) <= now
  return {
    kind: 'refused',
    code: expired ? 'ASSISTANT_TURN_UNCONFIRMED' : 'ASSISTANT_TURN_IN_PROGRESS',
    status: 409,
    message: expired
      ? 'This turn needs confirmation. Check your work before asking again. It will not be run twice.'
      : 'This turn is already running. Wait for its answer before retrying.',
    ...(!expired ? { retryAfter: 3 } : {}),
  }
}

function allowance(
  rows: RequestRow[],
  input: StartAssistantRequest,
  now: number,
): AssistantRequestClaim | undefined {
  const owned = rows.filter((row) => row.owner === input.owner.toLowerCase())
  if (owned.some(active))
    return {
      kind: 'refused',
      status: 409,
      code: 'ASSISTANT_WALLET_BUSY',
      message: 'Another turn for this wallet is running or needs confirmation. Check it first.',
    }
  if (rows.filter((row) => running(row, now)).length >= input.limits.globalConcurrent)
    return {
      kind: 'refused',
      status: 429,
      code: 'ASSISTANT_BUSY',
      retryAfter: 10,
      message: 'Fast mode is busy right now. Try again shortly.',
    }
  const recent = owned.filter((row) => timestamp(row.created_at) > now - 60_000)
  if (recent.length >= input.limits.walletPerMinute)
    return {
      kind: 'refused',
      status: 429,
      code: 'ASSISTANT_RATE_LIMIT',
      retryAfter: Math.max(
        1,
        Math.ceil(
          (Math.min(...recent.map((row) => timestamp(row.created_at))) + 60_000 - now) / 1000,
        ),
      ),
      message: `This wallet can start ${input.limits.walletPerMinute} Fast turns per minute. Wait a moment.`,
    }
  const day = rows.filter((row) => active(row) || timestamp(row.created_at) > now - 86_400_000)
  const walletPoints = day
    .filter((row) => row.owner === input.owner.toLowerCase())
    .reduce((sum, row) => sum + accounted(row), 0)
  const globalPoints = day.reduce((sum, row) => sum + accounted(row), 0)
  if (
    walletPoints + input.reservedPoints > input.limits.walletDailyPoints ||
    globalPoints + input.reservedPoints > input.limits.globalDailyPoints
  )
    return {
      kind: 'refused',
      status: 429,
      code: 'ASSISTANT_DAILY_LIMIT',
      message:
        'The daily Fast mode spending limit has been reached. Existing work and Manual mode are still available.',
    }
}

/** Only local development and tests use this store. Production uses PostgreSQL. */
export class InMemoryAssistantRequestStore implements AssistantRequestStore {
  private readonly rows = new Map<string, RequestRow>()
  async begin(input: StartAssistantRequest): Promise<AssistantRequestClaim> {
    const now = Date.now()
    const key = `${input.owner.toLowerCase()}:${input.key}`
    const existing = this.rows.get(key)
    if (existing) return replay(existing, input.requestHash, now)
    const refused = allowance([...this.rows.values()], input, now)
    if (refused) return refused
    const id = randomUUID()
    this.rows.set(key, {
      id,
      owner: input.owner.toLowerCase(),
      request_hash: input.requestHash,
      state: 'IN_PROGRESS',
      reserved_points: input.reservedPoints,
      usage_points: 0,
      response_status: null,
      response_body: null,
      created_at: new Date(now),
      lease_expires_at: new Date(now + input.limits.leaseSeconds * 1000),
    })
    return { kind: 'started', id }
  }
  async checkpoint(id: string, points: number, _input: number, _output: number) {
    const row = [...this.rows.values()].find((row) => row.id === id)
    if (!row || !active(row)) throw new Error('Fast turn is not active.')
    row.usage_points = Math.max(Number(row.usage_points), points)
  }
  async complete(input: {
    id: string
    status: number
    body: unknown
    points: number
    uncertain?: boolean
  }) {
    const row = [...this.rows.values()].find((row) => row.id === input.id)
    if (!row) throw new Error('Fast turn was not recorded.')
    if (row.response_status !== null) return
    row.state = input.uncertain ? 'UNCONFIRMED' : 'COMPLETED'
    row.usage_points = Math.max(Number(row.usage_points), input.points)
    row.response_status = input.status
    row.response_body = structuredClone(input.body)
  }
}

export class PostgresAssistantRequestStore implements AssistantRequestStore {
  constructor(private readonly sql: postgres.Sql) {}
  async begin(input: StartAssistantRequest): Promise<AssistantRequestClaim> {
    return this.sql.begin(async (tx) => {
      // One database lock guards the global budget and every per-wallet check,
      // including across API processes. It is released before any provider call.
      await tx`SELECT pg_advisory_xact_lock(714202601)`
      const clock = await tx<{ now: Date }[]>`SELECT now() AS now`
      const now = clock[0]?.now
      if (!now) throw new Error('The database clock could not be read.')
      const existing = await tx<RequestRow[]>`
        SELECT * FROM assistant_requests
        WHERE owner = ${input.owner.toLowerCase()} AND idempotency_key = ${input.key}
      `
      if (existing[0]) return replay(existing[0], input.requestHash, now.getTime())
      const rows = await tx<RequestRow[]>`
        SELECT * FROM assistant_requests
        WHERE state <> 'COMPLETED' OR created_at > now() - interval '1 day'
      `
      const refused = allowance(rows, input, now.getTime())
      if (refused) return refused
      const id = randomUUID()
      await tx`
        INSERT INTO assistant_requests (id, owner, idempotency_key, request_hash, reserved_points, lease_expires_at)
        VALUES (${id}, ${input.owner.toLowerCase()}, ${input.key}, ${input.requestHash}, ${input.reservedPoints}, now() + ${input.limits.leaseSeconds} * interval '1 second')
      `
      return { kind: 'started', id } as const
    })
  }
  async checkpoint(id: string, points: number, inputTokens: number, outputTokens: number) {
    const rows = await this.sql`
      UPDATE assistant_requests
      SET usage_points = GREATEST(usage_points, ${points}), input_tokens = ${inputTokens}, output_tokens = ${outputTokens}, updated_at = now()
      WHERE id = ${id} AND state = 'IN_PROGRESS' RETURNING id
    `
    if (!rows.length) throw new Error('Fast turn is not active.')
  }
  async complete(input: {
    id: string
    status: number
    body: unknown
    points: number
    uncertain?: boolean
  }) {
    await this.sql`
      UPDATE assistant_requests SET state = ${input.uncertain ? 'UNCONFIRMED' : 'COMPLETED'},
        usage_points = GREATEST(usage_points, ${input.points}), response_status = ${input.status},
        response_body = ${this.sql.json(input.body as never)}, updated_at = now()
      WHERE id = ${input.id} AND response_status IS NULL
    `
  }
}
