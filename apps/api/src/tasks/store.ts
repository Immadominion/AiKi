import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { ESCROW_ACCOUNT } from '../credits/store.js'
import type { TaskKind } from './kinds.js'

/**
 * Work posted for somebody else to do.
 *
 * The status field is the safety mechanism, not a label on one. Every
 * transition is a conditional UPDATE naming the statuses it will move from, so
 * the guarantees below are the database's and not a sequence of checks somebody
 * hoped would not interleave:
 *
 *   OPEN      -> CLAIMED    exactly one claimant wins
 *   CLAIMED   -> SUBMITTED  only the claimant may hand work in
 *   SUBMITTED -> SETTLED    the poster pays for work that exists
 *   SUBMITTED -> DISPUTED   the poster says it is not what was asked for
 *   OPEN      -> CANCELLED  and only from OPEN
 *
 * That last one is the important one. Once somebody has claimed a task, the
 * poster cannot take the money back: escrow is locked before the work is
 * visible and stays locked while it is being done. A marketplace without that
 * property lets a poster read a submission and then withdraw, which is theft
 * with extra steps, and it is the failure the research on this primitive
 * singles out.
 */

export type TaskStatus = 'OPEN' | 'CLAIMED' | 'SUBMITTED' | 'SETTLED' | 'CANCELLED' | 'DISPUTED'

export interface TaskRecord {
  id: string
  poster: string
  /** Set when an agent posted it, so the spend counts against its mandate. */
  authorizationId?: string
  title: string
  brief: string
  kind: TaskKind
  pricePoints: number
  feePoints: number
  totalPoints: number
  /** Base units of the settlement asset, for cap accounting. */
  outlay: bigint
  status: TaskStatus
  /** Set when this was hired from one named agent rather than posted openly. */
  assignedAgentId?: string
  /** True when this was commissioned from one party rather than opened to anybody. */
  directHire: boolean
  /** When AiKi called that agent's endpoint, and what happened if it did not work. */
  dispatchedAt?: string
  dispatchNote?: string
  claimedBy?: string
  claimedAt?: string
  /** How long the claimant has, chosen by the poster when posting. */
  workHours: number
  /** When the claim lapses and the work goes back on the board. */
  claimExpiresAt?: string
  /** When the poster runs out of time to answer and the claimant may take the money. */
  reviewExpiresAt?: string
  submission?: string
  submittedAt?: string
  resolution?: string
  decidedAt?: string
  createdAt: string
  updatedAt: string
}

export interface NewTask {
  poster: string
  authorizationId?: string
  title: string
  brief: string
  kind: TaskKind
  pricePoints: number
  feePoints: number
  totalPoints: number
  outlay: bigint
  workHours: number
  /**
   * Hire one named agent instead of opening this to whoever claims it.
   *
   * The owner is who the money reaches, because an agent has no AiKi account:
   * it is a URL in a registration document, and the address its registry entry
   * names is the only party that can be paid.
   */
  assigned?: { agentId: string; owner: string }
  /**
   * Hire one person, named by address.
   *
   * The same thing as hiring an agent from the seller's point of view and a
   * different thing from AiKi's: a person cannot be dispatched to, so nothing
   * is sent anywhere. They see it in their own list and hand it in there.
   */
  hiredPerson?: string
}

export interface TaskStore {
  /** Production capability: task state, exact ledger legs and refund cap commit together. */
  finalizePayment?(input: TaskPaymentInput): Promise<TaskPaymentResult | null>
  /** A committed request claim prevents retries from charging or dispatching twice. */
  beginCreateRequest?(owner: string, key: string, requestHash: string): Promise<TaskRequestClaim>
  completeCreateRequest?(id: string, statusCode: number, body: unknown): Promise<void>
  create(task: NewTask): Promise<TaskRecord>
  get(id: string): Promise<TaskRecord | null>
  /** The board. Open work only, newest first. */
  open(limit?: number): Promise<TaskRecord[]>
  /** What somebody posted, and what they are doing. Both, in one list. */
  mine(address: string, limit?: number): Promise<TaskRecord[]>
  /**
   * Take a task, if nobody else has.
   *
   * One conditional UPDATE. Two claimants arriving together is the ordinary
   * case on a board worth watching, and a read followed by a write would let
   * both of them start work on the same money.
   */
  /**
   * Take a task, or take over one whose claimant has run out of time.
   *
   * The two are one statement on purpose. A lapsed claim is not a state
   * somebody has to notice and clean up: the work simply becomes claimable
   * again, so a claimant who goes quiet costs the poster a delay rather than
   * their money.
   */
  claim(id: string, claimant: string): Promise<TaskRecord | null>
  /**
   * Take the payment for work handed in that the poster never answered.
   *
   * Only after the review window, and only by the person who did the work.
   * Silence from the side holding the goods is not a reason the side that made
   * them goes unpaid, and a poster who wants to say no has a button for it.
   */
  claimLapsedReview(id: string, claimant: string): Promise<TaskRecord | null>
  /** Hand work in. Only the claimant, and only once. */
  submit(id: string, claimant: string, submission: string): Promise<TaskRecord | null>
  /** Record what a hired agent handed back. AiKi calls it; it has no session. */
  recordDelivery(id: string, agentId: string, submission: string): Promise<TaskRecord | null>
  /** Note that we called an agent, and what came of it. */
  noteDispatch(id: string, note: string | null, attempted?: boolean): Promise<void>
  /** Trusted explicit provider decline: cancel, refund exact funding, and release the cap atomically. */
  refundDeclinedAssignment(id: string, agentId: string, note: string): Promise<TaskRecord | null>
  /**
   * Take back work whose claimant ran out of time.
   *
   * The only route out for a hire the agent never answered, and the reason a
   * buyer is not left holding a claim on somebody who has gone quiet. Open work
   * has the board as its other route; assigned work has nothing else, so
   * without this a hired agent that never replied would freeze the money
   * permanently.
   */
  cancelLapsedClaim(id: string, poster: string): Promise<TaskRecord | null>
  /** Move a task on, from one of `from` to `to`, and say whether this caller did it. */
  advance(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    resolution?: string,
  ): Promise<TaskRecord | null>
}

export interface TaskPaymentInput {
  taskId: string
  actor: string
  action: 'accept' | 'release' | 'cancel'
  treasury?: string
}
export interface TaskPaymentResult {
  task: TaskRecord
  alreadyFinalized: boolean
}

export type TaskRequestClaim =
  | { kind: 'started'; id: string }
  | { kind: 'replayed'; statusCode: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress' }

const lower = (address: string) => address.toLowerCase()

/**
 * How long a poster has to answer work that was handed in.
 *
 * Not settable by them, deliberately. They benefit from it being long, and a
 * limit whose length is chosen by the party it constrains is not a limit.
 */
export const REVIEW_HOURS = 72

interface TaskRow {
  id: string
  poster: string
  authorization_id: string | null
  title: string
  brief: string
  kind: string
  price_points: string | number
  fee_points: string | number
  total_points: string | number
  outlay: string
  status: TaskStatus
  assigned_agent_id: string | null
  direct_hire: boolean
  dispatched_at: Date | string | null
  dispatch_note: string | null
  claimed_by: string | null
  claimed_at: Date | string | null
  work_hours: number
  claim_expires_at: Date | string | null
  review_expires_at: Date | string | null
  submission: string | null
  submitted_at: Date | string | null
  resolution: string | null
  decided_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

const iso = (at: Date | string) => (at instanceof Date ? at.toISOString() : at)

const toTask = (row: TaskRow): TaskRecord => ({
  id: row.id,
  poster: row.poster,
  ...(row.authorization_id ? { authorizationId: row.authorization_id } : {}),
  title: row.title,
  brief: row.brief,
  kind: row.kind as TaskKind,
  pricePoints: Number(row.price_points),
  feePoints: Number(row.fee_points),
  totalPoints: Number(row.total_points),
  // Read as a string and parsed: a uint256 through Number loses its last digits
  // and this one is compared against a spend cap.
  outlay: BigInt(row.outlay),
  status: row.status,
  ...(row.assigned_agent_id ? { assignedAgentId: row.assigned_agent_id } : {}),
  directHire: row.direct_hire,
  ...(row.dispatched_at ? { dispatchedAt: iso(row.dispatched_at) } : {}),
  ...(row.dispatch_note ? { dispatchNote: row.dispatch_note } : {}),
  ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
  ...(row.claimed_at ? { claimedAt: iso(row.claimed_at) } : {}),
  workHours: Number(row.work_hours),
  ...(row.claim_expires_at ? { claimExpiresAt: iso(row.claim_expires_at) } : {}),
  ...(row.review_expires_at ? { reviewExpiresAt: iso(row.review_expires_at) } : {}),
  ...(row.submission ? { submission: row.submission } : {}),
  ...(row.submitted_at ? { submittedAt: iso(row.submitted_at) } : {}),
  ...(row.resolution ? { resolution: row.resolution } : {}),
  ...(row.decided_at ? { decidedAt: iso(row.decided_at) } : {}),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
})

export class PostgresTaskStore implements TaskStore {
  private readonly sql: postgres.Sql
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 4, idle_timeout: 20 })
  }

  /** No terminal task may commit ahead of its money. Legacy partial terminal
   * records are not automatically repaired: only this transaction's complete
   * marked ledger evidence permits a harmless readback retry. */
  async finalizePayment(input: TaskPaymentInput): Promise<TaskPaymentResult | null> {
    const address = (value: unknown): value is string =>
      typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value)
    if (!address(input.actor) || !['accept', 'release', 'cancel'].includes(input.action))
      throw new Error('Task payment actor or action is invalid.')
    const actor = lower(input.actor),
      refund = input.action === 'cancel'
    if (!refund && !address(input.treasury)) throw new Error('Task payment treasury is invalid.')
    return this.sql.begin(async (tx) => {
      const [task] = await tx<
        (TaskRow & { claim_lapsed: boolean | null; review_lapsed: boolean | null })[]
      >`
        SELECT *, claim_expires_at < now() AS claim_lapsed, review_expires_at < now() AS review_lapsed
        FROM tasks WHERE id = ${input.taskId} FOR UPDATE
      `
      if (
        !task ||
        (input.action === 'release'
          ? lower(task.claimed_by ?? '') !== actor
          : lower(task.poster) !== actor)
      )
        return null
      const terminal = task.status === (refund ? 'CANCELLED' : 'SETTLED')
      if (
        !terminal &&
        (refund
          ? !(
              task.status === 'OPEN' ||
              (task.status === 'CLAIMED' && task.claim_lapsed === true)
            ) ||
            task.submission !== null ||
            task.submitted_at !== null
          : task.status !== 'SUBMITTED' ||
            task.submission === null ||
            task.submitted_at === null ||
            (input.action === 'release' && task.review_lapsed !== true))
      )
        return null
      const total = BigInt(task.total_points),
        price = BigInt(task.price_points),
        fee = BigInt(task.fee_points)
      if (
        !address(task.poster) ||
        (!refund && !address(task.claimed_by)) ||
        total <= 0n ||
        price <= 0n ||
        fee < 0n ||
        total > BigInt(Number.MAX_SAFE_INTEGER) ||
        total !== price + fee
      )
        throw new Error('Task payment terms could not be verified.')
      const id = task.id,
        fundingReference = `task:${id}:funding`
      const movements = refund
        ? [
            {
              to: lower(task.poster),
              points: total,
              reason: 'task_refund',
              reference: `task:${id}:refund`,
            },
          ]
        : [
            {
              to: lower(task.claimed_by as string),
              points: price,
              reason: 'task_earnings',
              reference: `task:${id}:task_earnings`,
            },
            ...(fee > 0n
              ? [
                  {
                    to: lower(input.treasury as string),
                    points: fee,
                    reason: 'platform_fee',
                    reference: `task:${id}:platform_fee`,
                  },
                ]
              : []),
          ]
      const allReferences = [
        fundingReference,
        `task:${id}:refund`,
        `task:${id}:task_earnings`,
        `task:${id}:platform_fee`,
      ].flatMap((reference) => [`${reference}:out`, `${reference}:in`])
      const entries = await tx<
        {
          owner: string
          delta: string
          reason: string
          reference: string
          detail: Record<string, unknown>
        }[]
      >`
        SELECT owner, delta::text, reason, reference, detail FROM credit_entries
        WHERE reference = ANY(${allReferences})
      `
      const matching = (reference: string, owner: string, delta: bigint, reason: string) =>
        entries.find(
          (e) =>
            e.reference === reference &&
            e.owner === owner &&
            BigInt(e.delta) === delta &&
            e.reason === reason,
        )
      if (
        !matching(`${fundingReference}:out`, lower(task.poster), -total, 'task_funding') ||
        !matching(`${fundingReference}:in`, ESCROW_ACCOUNT, total, 'task_funding')
      )
        throw new Error('Task payment funding could not be verified.')
      if (terminal) {
        if (
          entries.length !== 2 + 2 * movements.length ||
          movements.some((m) => {
            const out = matching(`${m.reference}:out`, ESCROW_ACCOUNT, -m.points, m.reason),
              incoming = matching(`${m.reference}:in`, m.to, m.points, m.reason)
            return [out, incoming].some(
              (e) =>
                e?.detail.atomicTaskFinalization !== 1 ||
                e.detail.finalization !== (refund ? 'refund' : 'settlement') ||
                e.detail.taskId !== id,
            )
          })
        )
          throw new Error('Task terminal payment needs review; no money was moved.')
        return { task: toTask(task), alreadyFinalized: true }
      }
      if (entries.length !== 2) throw new Error('Task already has conflicting payment evidence.')

      // Match the credit store's ascending owner lock order. The task lock also
      // excludes callbacks, disputes, and the existing explicit-decline refund.
      const owners = [...new Set([ESCROW_ACCOUNT, ...movements.map((m) => m.to)])].sort()
      for (const owner of owners)
        await tx`INSERT INTO credit_balances (owner, balance) VALUES (${owner}, 0) ON CONFLICT (owner) DO NOTHING`
      const balances = await tx<{ owner: string; balance: string }[]>`
        SELECT owner, balance::text FROM credit_balances WHERE owner = ANY(${owners}) ORDER BY owner FOR UPDATE
      `
      const changes = new Map<string, bigint>([[ESCROW_ACCOUNT, -total]])
      for (const m of movements) changes.set(m.to, (changes.get(m.to) ?? 0n) + m.points)
      if (
        balances.length !== owners.length ||
        balances.some((b) => {
          const next = BigInt(b.balance) + (changes.get(b.owner) ?? 0n)
          return next < 0n || next > BigInt(Number.MAX_SAFE_INTEGER)
        })
      )
        throw new Error('Task payment balances could not be verified.')
      const detail = tx.json({
        taskId: id,
        atomicTaskFinalization: 1,
        finalization: refund ? 'refund' : 'settlement',
      })
      for (const m of movements)
        await tx`
        INSERT INTO credit_entries (id, owner, delta, reason, reference, detail) VALUES
          (${randomUUID()}, ${ESCROW_ACCOUNT}, ${(-m.points).toString()}, ${m.reason}, ${`${m.reference}:out`}, ${detail}),
          (${randomUUID()}, ${m.to}, ${m.points.toString()}, ${m.reason}, ${`${m.reference}:in`}, ${detail})
      `
      for (const [owner, delta] of changes)
        await tx`
        UPDATE credit_balances SET balance = balance + ${delta.toString()}::bigint, updated_at = now() WHERE owner = ${owner}
      `
      if (refund && task.authorization_id) {
        const outlay = BigInt(task.outlay)
        if (outlay <= 0n) throw new Error('Task mandate reservation could not be verified.')
        const released = await tx`
          UPDATE authorizations SET spent = spent - ${outlay.toString()}::numeric
          WHERE id = ${task.authorization_id} AND spent >= ${outlay.toString()}::numeric
            AND (owner IS NULL OR lower(owner) = ${lower(task.poster)}) RETURNING id
        `
        if (released.length !== 1)
          throw new Error('Task mandate reservation could not be verified.')
      }
      const [finished] = await tx<TaskRow[]>`
        UPDATE tasks SET status = ${refund ? 'CANCELLED' : 'SETTLED'}, decided_at = now(), updated_at = now(),
          resolution = ${refund ? 'The task payment was refunded and its reserved allowance returned.' : 'The submitted work was paid in full.'}
        WHERE id = ${id} RETURNING *
      `
      if (!finished) throw new Error('Task payment could not be recorded.')
      return { task: toTask(finished), alreadyFinalized: false }
    })
  }

  async beginCreateRequest(
    owner: string,
    key: string,
    requestHash: string,
  ): Promise<TaskRequestClaim> {
    // Task balances belong to an address, independent of the wallet's selected
    // network. Use its BNB registry actor so switching networks cannot bypass
    // the same request key. The claim commits before any external side effect.
    return this.sql.begin(async (tx) => {
      const actors = await tx<{ id: string }[]>`
        INSERT INTO actors (id, actor_type, chain_id, controller_address)
        VALUES (${randomUUID()}, 'HUMAN', 56, ${lower(owner)})
        ON CONFLICT (chain_id, controller_address) WHERE actor_type = 'HUMAN'
        DO UPDATE SET controller_address = EXCLUDED.controller_address
        RETURNING id
      `
      const actor = actors[0]
      if (!actor) throw new Error('The task requester could not be recorded.')
      const id = randomUUID()
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO idempotency_records
          (id, actor_id, operation, idempotency_key, request_hash, expires_at)
        VALUES (${id}, ${actor.id}, 'v1.tasks.create', ${key}, ${requestHash}, now() + interval '90 days')
        ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING
        RETURNING id
      `
      if (inserted.length) return { kind: 'started', id } as const
      const records = await tx<
        {
          request_hash: string
          status: string
          response_status: number | null
          response_body: unknown
        }[]
      >`
        SELECT request_hash, status, response_status, response_body FROM idempotency_records
        WHERE actor_id = ${actor.id} AND operation = 'v1.tasks.create' AND idempotency_key = ${key}
      `
      const record = records[0]
      if (!record) throw new Error('The task request record could not be read.')
      if (record.request_hash !== requestHash) return { kind: 'conflict' } as const
      if (record.status === 'COMPLETED' && record.response_status !== null)
        return {
          kind: 'replayed',
          statusCode: record.response_status,
          body: record.response_body,
        } as const
      // An uncertain original request must not be restarted automatically: it
      // may already have reserved a cap, moved points, or reached the agent.
      return { kind: 'in_progress' } as const
    })
  }

  async completeCreateRequest(id: string, statusCode: number, body: unknown): Promise<void> {
    await this.sql`
      UPDATE idempotency_records
      SET status = 'COMPLETED', response_status = ${statusCode},
          response_body = ${this.sql.json(body as never)}, updated_at = now()
      WHERE id = ${id} AND operation = 'v1.tasks.create' AND status = 'IN_PROGRESS'
    `
  }

  async create(task: NewTask) {
    const rows = await this.sql<TaskRow[]>`
      INSERT INTO tasks
        (id, poster, authorization_id, title, brief, kind,
         price_points, fee_points, total_points, outlay, work_hours, status,
         assigned_agent_id, claimed_by, claimed_at, claim_expires_at, direct_hire)
      VALUES (${randomUUID()}, ${lower(task.poster)}, ${task.authorizationId ?? null},
              ${task.title}, ${task.brief}, ${task.kind},
              ${task.pricePoints}, ${task.feePoints}, ${task.totalPoints},
              ${task.outlay.toString()}, ${task.workHours},
              -- Assigned work starts claimed, because the claimant was decided
              -- before the money was committed. The same clock starts with it,
              -- so an agent that never answers frees the poster's money on the
              -- same terms a person who goes quiet does.
              ${task.assigned || task.hiredPerson ? 'CLAIMED' : 'OPEN'},
              ${task.assigned?.agentId ?? null},
              ${
                task.assigned
                  ? lower(task.assigned.owner)
                  : task.hiredPerson
                    ? lower(task.hiredPerson)
                    : null
              },
              ${task.assigned || task.hiredPerson ? this.sql`now()` : null},
              ${
                task.assigned || task.hiredPerson
                  ? this.sql`now() + (${task.workHours} || ' hours')::interval`
                  : null
              },
              ${Boolean(task.assigned || task.hiredPerson)})
      RETURNING *
    `
    const row = rows[0]
    if (!row) throw new Error('The task could not be created.')
    return toTask(row)
  }

  async get(id: string) {
    const rows = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id}`
    const row = rows[0]
    return row ? toTask(row) : null
  }

  async open(limit = 50) {
    /*
     * Open work includes work whose claimant ran out of time. There is no sweep
     * and no cleanup job: a lapsed claim IS availability, computed at read time,
     * so nothing depends on a background process having run recently.
     */
    const rows = await this.sql<TaskRow[]>`
      SELECT * FROM tasks
       -- Commissioned work never returns to the board. They hired one party,
       -- so if that party goes quiet the money goes back to the buyer rather
       -- than to whoever happened to be watching.
       WHERE NOT direct_hire
         AND (
           status = 'OPEN'
           OR (status = 'CLAIMED' AND claim_expires_at IS NOT NULL AND claim_expires_at < now())
         )
       ORDER BY created_at DESC LIMIT ${limit}
    `
    return rows.map(toTask)
  }

  async mine(address: string, limit = 50) {
    const rows = await this.sql<TaskRow[]>`
      SELECT * FROM tasks
       WHERE poster = ${lower(address)} OR claimed_by = ${lower(address)}
       ORDER BY created_at DESC LIMIT ${limit}
    `
    return rows.map(toTask)
  }

  async claim(id: string, claimant: string) {
    /*
     * The poster may not claim their own task. Not a rule about fairness: a
     * poster who claims and settles their own work moves money from their
     * balance to their balance minus a fee, which is a way to launder a
     * mandate's spend into their own pocket while the cap records it as paid
     * work.
     */
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
         SET status = 'CLAIMED', claimed_by = ${lower(claimant)},
             claimed_at = now(),
             claim_expires_at = now() + (work_hours || ' hours')::interval,
             updated_at = now()
       WHERE id = ${id}
         AND poster <> ${lower(claimant)}
         -- Work hired from one agent is not up for grabs, whatever the clock
         -- says. If that agent does not answer, the money goes back to the
         -- buyer rather than to whoever was watching the board.
         AND NOT direct_hire
         AND (
           status = 'OPEN'
           -- Or the last claimant ran out of time, in which case this is a
           -- takeover and the clock starts again for whoever is here now.
           OR (status = 'CLAIMED' AND claim_expires_at IS NOT NULL AND claim_expires_at < now())
         )
      RETURNING *
    `
    const row = rows[0]
    return row ? toTask(row) : null
  }

  async submit(id: string, claimant: string, submission: string) {
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
         SET status = 'SUBMITTED', submission = ${submission},
             submitted_at = now(),
             review_expires_at = now() + ${REVIEW_HOURS} * interval '1 hour',
             updated_at = now()
       WHERE id = ${id} AND status = 'CLAIMED' AND claimed_by = ${lower(claimant)}
         -- Handing in after the deadline is still handing in, but not once
         -- somebody else has taken the work over.
         AND (claim_expires_at IS NULL OR claim_expires_at > now())
      RETURNING *
    `
    const row = rows[0]
    return row ? toTask(row) : null
  }

  /**
   * Record what a hired agent handed back, on its behalf.
   *
   * Separate from `submit` because the agent is not the caller and has no
   * session: AiKi called its endpoint and this is the answer. The guard is the
   * same in substance though, and the deadline still applies, so a reply that
   * arrives after the buyer's money has already gone back changes nothing.
   */
  async recordDelivery(id: string, agentId: string, submission: string) {
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
         SET status = 'SUBMITTED', submission = ${submission},
             submitted_at = now(),
             review_expires_at = now() + ${REVIEW_HOURS} * interval '1 hour',
             updated_at = now()
       WHERE id = ${id} AND status = 'CLAIMED' AND assigned_agent_id = ${agentId}
         AND (claim_expires_at IS NULL OR claim_expires_at > now())
      RETURNING *
    `
    const row = rows[0]
    return row ? toTask(row) : null
  }

  /** Note that we called an agent, and what came of it. */
  async noteDispatch(id: string, note: string | null, attempted = true) {
    await this.sql`
      UPDATE tasks SET dispatched_at = CASE WHEN ${attempted} THEN now() ELSE dispatched_at END,
        dispatch_note = ${note}, updated_at = now()
       WHERE id = ${id}
    `
  }

  async refundDeclinedAssignment(id: string, agentId: string, note: string) {
    return this.sql.begin(async (tx) => {
      // This row lock arbitrates against both callback delivery and manual submit.
      // A committed submission cannot be cancelled; cancellation prevents a later delivery.
      const [task] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} FOR UPDATE`
      if (
        task?.status !== 'CLAIMED' ||
        !task.direct_hire ||
        task.assigned_agent_id !== agentId ||
        task.submission !== null ||
        task.submitted_at !== null
      )
        return null
      const points = BigInt(task.total_points)
      if (
        points <= 0n ||
        points > BigInt(Number.MAX_SAFE_INTEGER) ||
        points !== BigInt(task.price_points) + BigInt(task.fee_points)
      )
        throw new Error('Task refund amount could not be verified.')
      const fundingReference = `task:${id}:funding`
      const funding = await tx<
        { owner: string; delta: string; reason: string; reference: string }[]
      >`
        SELECT owner, delta::text, reason, reference FROM credit_entries
        WHERE reference IN (${`${fundingReference}:out`}, ${`${fundingReference}:in`})
      `
      const paid = funding.find((entry) => entry.reference === `${fundingReference}:out`)
      const held = funding.find((entry) => entry.reference === `${fundingReference}:in`)
      // Refund the actual funding source, never a claimant or an authorization owner.
      // A different payer is inconsistent with this task's original funding contract.
      if (
        funding.length !== 2 ||
        !paid ||
        !held ||
        paid.owner !== lower(task.poster) ||
        paid.owner === ESCROW_ACCOUNT ||
        held.owner !== ESCROW_ACCOUNT ||
        paid.reason !== 'task_funding' ||
        held.reason !== 'task_funding' ||
        BigInt(paid.delta) !== -points ||
        BigInt(held.delta) !== points
      )
        throw new Error('Task funding could not be verified for this refund.')

      // Same ascending-owner credit lock order as PostgresCreditStore.transfer.
      const owners = [paid.owner, ESCROW_ACCOUNT].sort()
      const balances = await tx<{ owner: string; balance: string }[]>`
        SELECT owner, balance::text FROM credit_balances
        WHERE owner = ANY(${owners}) ORDER BY owner FOR UPDATE
      `
      const escrow = balances.find((balance) => balance.owner === ESCROW_ACCOUNT)
      const payer = balances.find((balance) => balance.owner === paid.owner)
      if (
        balances.length !== 2 ||
        !escrow ||
        !payer ||
        BigInt(escrow.balance) < points ||
        BigInt(payer.balance) < 0n ||
        BigInt(payer.balance) + points > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error('Task refund balances could not be verified.')

      const [cancelled] = await tx<TaskRow[]>`
        UPDATE tasks SET status = 'CANCELLED', resolution = 'The assigned agent declined without delivering. The full payment was refunded.',
          dispatched_at = COALESCE(dispatched_at, now()), dispatch_note = ${note},
          decided_at = now(), updated_at = now()
        WHERE id = ${id} RETURNING *
      `
      const reference = `task:${id}:refund`
      const detail = tx.json({ taskId: id, agentId, cause: 'provider_declined' })
      // Both globally unique legs, the balances, cap, and task state commit together.
      // A reference conflict or any later failure rolls the entire cancellation back.
      await tx`
        INSERT INTO credit_entries (id, owner, delta, reason, reference, detail) VALUES
          (${randomUUID()}, ${ESCROW_ACCOUNT}, ${(-points).toString()}, 'task_refund', ${`${reference}:out`}, ${detail}),
          (${randomUUID()}, ${paid.owner}, ${points.toString()}, 'task_refund', ${`${reference}:in`}, ${detail})
      `
      await tx`
        UPDATE credit_balances SET balance = balance + CASE WHEN owner = ${paid.owner}
          THEN ${points.toString()}::bigint ELSE ${(-points).toString()}::bigint END, updated_at = now()
        WHERE owner = ANY(${owners})
      `
      if (task.authorization_id) {
        const outlay = BigInt(task.outlay)
        if (outlay <= 0n) throw new Error('Task mandate reservation could not be verified.')
        const released = await tx`
          UPDATE authorizations SET spent = spent - ${outlay.toString()}::numeric
          WHERE id = ${task.authorization_id} AND spent >= ${outlay.toString()}::numeric
            AND (owner IS NULL OR lower(owner) = ${paid.owner})
          RETURNING id
        `
        if (released.length !== 1)
          throw new Error('Task mandate reservation could not be verified.')
      }
      if (!cancelled) throw new Error('Task cancellation could not be recorded.')
      return toTask(cancelled)
    })
  }

  async cancelLapsedClaim(id: string, poster: string) {
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
         SET status = 'CANCELLED',
             resolution = 'Nobody handed it in before the deadline, so the poster took it back.',
             decided_at = now(), updated_at = now()
       WHERE id = ${id} AND poster = ${lower(poster)} AND status = 'CLAIMED'
         AND claim_expires_at IS NOT NULL AND claim_expires_at < now()
      RETURNING *
    `
    const row = rows[0]
    return row ? toTask(row) : null
  }

  async claimLapsedReview(id: string, claimant: string) {
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
         SET status = 'SETTLED',
             resolution = 'The poster did not answer in time, so the payment was released.',
             decided_at = now(), updated_at = now()
       WHERE id = ${id} AND status = 'SUBMITTED' AND claimed_by = ${lower(claimant)}
         AND review_expires_at IS NOT NULL AND review_expires_at < now()
      RETURNING *
    `
    const row = rows[0]
    return row ? toTask(row) : null
  }

  async advance(id: string, from: TaskStatus[], to: TaskStatus, resolution?: string) {
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
         SET status = ${to},
             resolution = COALESCE(${resolution ?? null}, resolution),
             decided_at = now(), updated_at = now()
       WHERE id = ${id} AND status = ANY(${from})
      RETURNING *
    `
    const row = rows[0]
    return row ? toTask(row) : null
  }

  async close() {
    await this.sql.end()
  }
}
