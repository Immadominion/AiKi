import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
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
}

export interface TaskStore {
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
  /** Move a task on, from one of `from` to `to`, and say whether this caller did it. */
  advance(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    resolution?: string,
  ): Promise<TaskRecord | null>
}

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

  async create(task: NewTask) {
    const rows = await this.sql<TaskRow[]>`
      INSERT INTO tasks
        (id, poster, authorization_id, title, brief, kind,
         price_points, fee_points, total_points, outlay, work_hours, status)
      VALUES (${randomUUID()}, ${lower(task.poster)}, ${task.authorizationId ?? null},
              ${task.title}, ${task.brief}, ${task.kind},
              ${task.pricePoints}, ${task.feePoints}, ${task.totalPoints},
              ${task.outlay.toString()}, ${task.workHours}, 'OPEN')
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
       WHERE status = 'OPEN'
          OR (status = 'CLAIMED' AND claim_expires_at IS NOT NULL AND claim_expires_at < now())
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
