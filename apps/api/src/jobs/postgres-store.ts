import { randomUUID } from 'node:crypto'
import type { SignedDelegation } from '@aiki/contracts'
import postgres from 'postgres'
import type { CompiledPolicy } from '../authority/policy.js'
import { pointsForSettlement } from '../credits/pricing.js'
import { ESCROW_ACCOUNT } from '../credits/store.js'
import type { ExecutionAttempt, ExecutionState } from '../execution/attempts.js'
import { ClientError } from '../http/errors.js'
import { priceJob, SETTLEMENT } from '../settlement/pricing.js'
import { authorizationReplay } from './authorization-retry.js'
import type {
  ApprovalRequest,
  AuthorizationRecord,
  AuthorizationStatus,
  CreditPaymentClaim,
  JobEvent,
  JobFundingInput,
  JobFundingResult,
  JobRecord,
  JobRefundInput,
  JobRefundResult,
  JobStatus,
  JobStore,
  SpendVerdict,
} from './store.js'

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value)

const fundingMarker = (input: {
  jobId: string
  authorizationId: string
  buyer: string
  agentId: string
  pricePoints: bigint
  totalPoints: bigint
  outlay: bigint
  policyHash: string
}) =>
  JSON.stringify({
    kind: 'atomic_job_funding_v1',
    jobId: input.jobId,
    authorizationId: input.authorizationId,
    buyer: input.buyer,
    agentId: input.agentId,
    pricePoints: input.pricePoints.toString(),
    totalPoints: input.totalPoints.toString(),
    outlay: input.outlay.toString(),
    asset: SETTLEMENT.address.toLowerCase(),
    policyHash: input.policyHash,
  })

interface ExecutionRow {
  id: string
  authorization_id: string
  job_id: string
  chain_id: number
  executor_address: `0x${string}` | null
  state: ExecutionState
  transaction_hash: `0x${string}` | null
  created_at: Date
}

const toExecution = (row: ExecutionRow): ExecutionAttempt => ({
  id: row.id,
  authorizationId: row.authorization_id,
  jobId: row.job_id,
  chainId: Number(row.chain_id),
  ...(row.executor_address ? { executorAddress: row.executor_address } : {}),
  state: row.state,
  createdAt: iso(row.created_at),
  ...(row.transaction_hash ? { transactionHash: row.transaction_hash } : {}),
})

interface AuthorizationRow {
  id: string
  policy: CompiledPolicy
  status: AuthorizationStatus
  spent: string
  created_at: string | Date
  revoked_at: string | Date | null
  owner: string | null
  delegation: SignedDelegation | null
  delegator: string | null
  delegation_chain_id: number | string | null
  delegation_signed_at: string | Date | null
}

interface ApprovalRow {
  id: string
  job_id: string
  authorization_id: string
  target: string
  selector: string
  asset: string
  amount: string
  recipient: string | null
  reason: string
  status: ApprovalRequest['status']
  requested_at: Date | string
  decided_at: Date | string | null
}

const asIso = (at: Date | string) => (at instanceof Date ? at.toISOString() : at)

const toApproval = (row: ApprovalRow): ApprovalRequest => ({
  id: row.id,
  jobId: row.job_id,
  authorizationId: row.authorization_id,
  target: row.target,
  selector: row.selector,
  asset: row.asset,
  // Read as a string and parsed. A uint256 amount loses precision through
  // Number, and this one is shown to a person who is about to agree to it.
  amount: BigInt(row.amount),
  recipient: row.recipient ?? null,
  reason: row.reason,
  status: row.status,
  requestedAt: asIso(row.requested_at),
  ...(row.decided_at ? { decidedAt: asIso(row.decided_at) } : {}),
})

interface JobRow {
  id: string
  authorization_id: string
  status: JobStatus
  idempotency_key: string
  created_at: string | Date
  sold_agent_id: string | null
  sold_price_points: string | number | null
  sold_total_points: string | number | null
  sold_outlay: string | number | null
}

interface EventRow {
  type: JobEvent['type']
  detail: string
  at: string | Date
}

const toAuthorization = (row: AuthorizationRow): AuthorizationRecord => ({
  id: row.id,
  policy: row.policy,
  status: row.status,
  // NUMERIC comes back as a string precisely so it does not lose precision in
  // a float; BigInt is the only safe destination for it.
  spent: BigInt(row.spent),
  createdAt: iso(row.created_at),
  owner: row.owner,
  ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  ...(row.delegation ? { delegation: row.delegation } : {}),
  ...(row.delegator ? { delegator: row.delegator } : {}),
  // INTEGER arrives as a number here, but every other numeric column in this
  // file has arrived as a string at least once, and a chain id read as "97"
  // would never match a comparison against 97.
  ...(row.delegation_chain_id === null
    ? {}
    : { delegationChainId: Number(row.delegation_chain_id) }),
  ...(row.delegation_signed_at ? { delegationSignedAt: iso(row.delegation_signed_at) } : {}),
})

/** Authorizations, jobs, and their event logs, in Postgres. */
export class PostgresJobStore implements JobStore {
  private readonly sql: postgres.Sql

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5 })
  }

  async beginExecution(attempt: ExecutionAttempt) {
    return this.sql.begin(async (tx) => {
      // This short transaction serializes the legacy-unknown check and insert.
      // The durable attempt, NOT the connection/advisory lock, guards the nonce
      // until a terminal outcome; crashes and timeouts must never clear it.
      await tx`SELECT pg_advisory_xact_lock(1095322441, ${attempt.chainId}::integer)`
      await tx`SELECT id FROM authorizations WHERE id = ${attempt.authorizationId} FOR UPDATE`
      const strategy =
        await tx`SELECT id FROM strategy_watches WHERE authorization_id = ${attempt.authorizationId}`
      if (strategy.length)
        throw new ClientError(
          'Use the strategy controls for this mandate. Generic actions cannot execute it.',
          {
            code: 'STRATEGY_EXECUTION_REQUIRED',
            statusCode: 409,
          },
        )
      const pending = await tx`
        SELECT id FROM execution_attempts WHERE chain_id = ${attempt.chainId}
        AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED')
        AND (executor_address IS NULL OR ${attempt.executorAddress ?? null}::text IS NULL
          OR executor_address = ${attempt.executorAddress ?? null}) LIMIT 1
      `
      if (pending.length) return false
      const rows = await tx`
        INSERT INTO execution_attempts (id, authorization_id, job_id, chain_id, executor_address, state, created_at)
        SELECT ${attempt.id}, ${attempt.authorizationId}, id, ${attempt.chainId}, ${attempt.executorAddress ?? null}, 'PREPARING', ${attempt.createdAt}
        FROM jobs WHERE id = ${attempt.jobId} AND authorization_id = ${attempt.authorizationId}
        ON CONFLICT DO NOTHING RETURNING id
      `
      return rows.length === 1
    })
  }

  async pendingExecution(authorizationId: string): Promise<ExecutionAttempt | null> {
    const rows = await this.sql<ExecutionRow[]>`
      SELECT * FROM execution_attempts WHERE authorization_id = ${authorizationId}
      AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED')
    `
    return rows[0] ? toExecution(rows[0]) : null
  }

  async pendingExecutionForExecutor(
    chainId: number,
    address?: string,
  ): Promise<ExecutionAttempt | null> {
    const rows = await this.sql<ExecutionRow[]>`
      SELECT * FROM execution_attempts WHERE chain_id = ${chainId}
      AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED')
      AND (executor_address IS NULL OR ${address ?? null}::text IS NULL OR executor_address = ${address ?? null})
      ORDER BY created_at, id LIMIT 1
    `
    return rows[0] ? toExecution(rows[0]) : null
  }

  async recordExecutionHash(id: string, hash: `0x${string}`) {
    await this.sql.begin(async (tx) => {
      const rows = await tx<
        { job_id: string; chain_id: number; transaction_hash: string | null }[]
      >`
        SELECT job_id, chain_id, transaction_hash FROM execution_attempts
        WHERE id = ${id} AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED') FOR UPDATE
      `
      const row = rows[0]
      if (!row || (row.transaction_hash && row.transaction_hash !== hash))
        throw new Error('Execution hash cannot be changed.')
      if (row.transaction_hash) return
      await tx`UPDATE execution_attempts SET transaction_hash = ${hash}, state = 'SUBMITTED', updated_at = now() WHERE id = ${id}`
      await tx`INSERT INTO job_events (job_id, type, detail, at) VALUES (${row.job_id}, 'status', ${`Execution prepared on chain ${row.chain_id}: ${hash}. Confirmation is pending; do not repeat it.`}, now())`
    })
  }

  async finishExecution(
    id: string,
    state: Exclude<ExecutionState, 'PREPARING' | 'SUBMITTED'>,
    release: bigint,
  ) {
    if (state === 'UNCONFIRMED' && release !== 0n)
      throw new Error('Unconfirmed execution cannot release a spending limit.')
    await this.sql.begin(async (tx) => {
      const rows = await tx<
        {
          authorization_id: string
          job_id: string
          chain_id: number
          transaction_hash: string | null
        }[]
      >`
        SELECT authorization_id, job_id, chain_id, transaction_hash FROM execution_attempts
        WHERE id = ${id} AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED') FOR UPDATE
      `
      const row = rows[0]
      if (!row) return
      if (release > 0n)
        await tx`UPDATE authorizations SET spent = GREATEST(0, spent - ${release.toString()}::numeric) WHERE id = ${row.authorization_id}`
      await tx`UPDATE execution_attempts SET state = ${state}, updated_at = now() WHERE id = ${id}`
      await tx`INSERT INTO job_events (job_id, type, detail, at) VALUES (${row.job_id}, 'status', ${`Execution ${state.toLowerCase()} on chain ${row.chain_id}${row.transaction_hash ? `: ${row.transaction_hash}` : ''}.${state === 'UNCONFIRMED' ? ' Spending limit held. Review required; no automatic retry.' : ''}`}, now())`
    })
  }

  async createAuthorization(record: AuthorizationRecord, allowReplay = false) {
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO authorizations (id, policy_hash, policy, weakest_tier, status, spent, expires_at, created_at, owner)
      VALUES (
        ${record.id},
        ${record.policy.hash},
        ${this.sql.json(record.policy as unknown as postgres.JSONValue)},
        ${record.policy.weakestTier},
        ${record.status},
        ${record.spent.toString()},
        ${record.policy.expiresAt ?? null},
        ${record.createdAt},
        ${record.owner}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `
    if (!inserted.length) {
      if (!allowReplay)
        throw new ClientError('This authorization already exists.', { statusCode: 409 })
      // INSERT waits for the competing transaction. A separate READ COMMITTED
      // statement sees that committed row, including any newer revoke/sign state.
      return authorizationReplay(record, await this.getAuthorization(record.id))
    }
    return record
  }

  async getAuthorization(id: string) {
    const rows = await this.sql<AuthorizationRow[]>`SELECT * FROM authorizations WHERE id = ${id}`
    const row = rows[0]
    return row ? toAuthorization(row) : null
  }

  async revokeAuthorization(id: string, at: string) {
    const rows = await this.sql<AuthorizationRow[]>`
      UPDATE authorizations SET status = 'revoked', revoked_at = ${at}
      WHERE id = ${id} RETURNING *
    `
    const row = rows[0]
    return row ? toAuthorization(row) : null
  }

  async attachDelegation(
    id: string,
    delegation: SignedDelegation,
    delegator: string,
    chainId: number,
    at: string,
  ) {
    // `delegation IS NULL` in the WHERE, not a read-then-write: two requests
    // racing to sign the same mandate would otherwise both read no delegation
    // and the second would overwrite the first. The first signature stands.
    const rows = await this.sql<AuthorizationRow[]>`
      UPDATE authorizations
      SET delegation = ${this.sql.json(delegation as unknown as postgres.JSONValue)},
          delegator = ${delegator},
          delegation_chain_id = ${chainId},
          delegation_signed_at = ${at}
      WHERE id = ${id} AND delegation IS NULL
      RETURNING *
    `
    const row = rows[0]
    // Nothing updated means either no such mandate or one already signed. The
    // caller is handed whatever is actually stored rather than an error, so a
    // retried request is idempotent instead of alarming.
    if (row) return toAuthorization(row)
    return this.getAuthorization(id)
  }

  async createJob(record: JobRecord) {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO jobs (id, authorization_id, status, idempotency_key, created_at, updated_at)
        VALUES (${record.id}, ${record.authorizationId}, ${record.status}, ${record.idempotencyKey}, ${record.createdAt}, ${record.createdAt})
      `
      for (const event of record.events)
        await tx`
          INSERT INTO job_events (job_id, type, detail, at)
          VALUES (${record.id}, ${event.type}, ${event.detail}, ${event.at})
        `
    })
    return record
  }

  async getJob(id: string) {
    const rows = await this.sql<JobRow[]>`SELECT * FROM jobs WHERE id = ${id}`
    const row = rows[0]
    if (!row) return null
    return this.hydrate(row)
  }

  async jobByIdempotencyKey(key: string) {
    const rows = await this.sql<JobRow[]>`SELECT * FROM jobs WHERE idempotency_key = ${key}`
    const row = rows[0]
    return row ? this.hydrate(row) : null
  }

  async appendEvents(jobId: string, events: JobEvent[], status?: JobStatus) {
    if (!events.length && !status) return
    await this.sql.begin(async (tx) => {
      for (const event of events)
        await tx`
          INSERT INTO job_events (job_id, type, detail, at)
          VALUES (${jobId}, ${event.type}, ${event.detail}, ${event.at})
        `
      if (status)
        await tx`UPDATE jobs SET status = ${status}, updated_at = now() WHERE id = ${jobId}`
    })
  }

  /**
   * Evaluating a cap and committing the spend happen under a row lock, so two
   * concurrent actions cannot both read the same total and both squeeze past a
   * cap only one of them fits under.
   */
  async releaseSpend(authorizationId: string, amount: bigint) {
    // GREATEST rather than a read-then-write: the subtraction happens inside the
    // one statement, so it cannot race another action's charge, and the floor is
    // applied by the database rather than by whoever called this.
    await this.sql`
      UPDATE authorizations
      SET spent = GREATEST(spent - ${amount.toString()}, 0)
      WHERE id = ${authorizationId}
    `
  }

  async fundCreditJob(
    input: JobFundingInput,
    evaluate: (authorization: AuthorizationRecord, outlay: bigint) => SpendVerdict,
  ): Promise<JobFundingResult | null> {
    const review = () =>
      new ClientError('This job needs a ledger review before funding can be confirmed.', {
        statusCode: 409,
        code: 'JOB_FUNDING_REVIEW_REQUIRED',
      })
    return this.sql.begin(async (tx) => {
      // NO KEY UPDATE serializes sale/state changes without conflicting with
      // execution's job FK check while that path holds the authorization lock.
      const [job] = await tx<JobRow[]>`
        SELECT * FROM jobs WHERE id = ${input.jobId} FOR NO KEY UPDATE
      `
      if (!job) throw new ClientError('Job not found.', { statusCode: 404, code: 'NOT_FOUND' })
      if (!['AUTHORIZED', 'FUNDED'].includes(job.status))
        throw new ClientError('This job cannot be funded or reopened.', {
          statusCode: 409,
          code: 'JOB_NOT_FUNDABLE',
        })
      const buyer = input.buyer.toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(buyer) || /^0x0{40}$/.test(buyer) || !input.agentId)
        throw review()
      const rejectStrategy = async () => {
        const rows = await tx`
          SELECT id FROM strategy_watches WHERE authorization_id = ${job.authorization_id} LIMIT 1
        `
        if (rows.length)
          throw new ClientError('Use the strategy controls for this mandate.', {
            code: 'STRATEGY_EXECUTION_REQUIRED',
            statusCode: 409,
          })
      }
      await rejectStrategy()
      const owners = [buyer, ESCROW_ACCOUNT].sort()
      // Readbacks never create balance rows. Cold funding initializes and locks
      // them in the same order as every other credit transfer.
      if (input.price !== undefined && job.status === 'AUTHORIZED')
        for (const owner of owners)
          await tx`
            INSERT INTO credit_balances (owner, balance) VALUES (${owner}, 0)
            ON CONFLICT (owner) DO NOTHING
          `
      const balances = await tx<{ owner: string; balance: string }[]>`
        SELECT owner, balance::text FROM credit_balances
        WHERE owner = ANY(${owners}) ORDER BY owner FOR UPDATE
      `
      const [authorization] = await tx<AuthorizationRow[]>`
        SELECT * FROM authorizations WHERE id = ${job.authorization_id} FOR UPDATE
      `
      if (!authorization || authorization.owner?.toLowerCase() !== buyer)
        throw new ClientError('This job belongs to another owner.', {
          code: 'FORBIDDEN',
          statusCode: 403,
        })
      await rejectStrategy()
      const funding = `job:${job.id}:funding`
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
        WHERE reference = ANY(${[
          funding,
          `${funding}:out`,
          `${funding}:in`,
          ...['refund', 'job_earnings', 'platform_fee'].flatMap((reason) =>
            ['', ':out', ':in'].map((suffix) => `job:${job.id}:${reason}${suffix}`),
          ),
        ]})
      `
      const events = await tx<{ detail: string }[]>`
        SELECT detail FROM job_events WHERE job_id = ${job.id} AND type = 'spend'
      `
      const payerBalance = BigInt(balances.find((row) => row.owner === buyer)?.balance ?? '0'),
        escrowBalance = BigInt(
          balances.find((row) => row.owner === ESCROW_ACCOUNT)?.balance ?? '0',
        ),
        spent = BigInt(authorization.spent)
      if (
        payerBalance < 0n ||
        payerBalance > BigInt(Number.MAX_SAFE_INTEGER) ||
        escrowBalance < 0n ||
        escrowBalance > BigInt(Number.MAX_SAFE_INTEGER) ||
        spent < 0n ||
        spent >= 1n << 256n
      )
        throw review()
      const markerFor = (pricePoints: bigint, totalPoints: bigint, outlay: bigint) =>
        fundingMarker({
          jobId: job.id,
          authorizationId: job.authorization_id,
          buyer,
          agentId: input.agentId,
          pricePoints,
          totalPoints,
          outlay,
          policyHash: authorization.policy.hash,
        })
      const hasSale = [
        job.sold_agent_id,
        job.sold_price_points,
        job.sold_total_points,
        job.sold_outlay,
      ].some((value) => value !== null)
      if (job.status === 'FUNDED' || hasSale || entries.length || events.length) {
        // A prior AUTHORIZED sale or credit movement cannot prove which cap
        // reservation survived. Only a completed atomic funding is recoverable.
        if (
          job.status !== 'FUNDED' ||
          job.sold_agent_id === null ||
          job.sold_price_points === null ||
          job.sold_total_points === null ||
          job.sold_outlay === null
        )
          throw review()
        if (job.sold_agent_id !== input.agentId)
          throw new ClientError('This retry does not match the recorded sale.', {
            code: 'JOB_ALREADY_SOLD',
            statusCode: 409,
          })
        const price = BigInt(job.sold_price_points),
          total = BigInt(job.sold_total_points),
          outlay = BigInt(job.sold_outlay)
        const exact = (reference: string, owner: string, delta: bigint) =>
          entries.some(
            (entry) =>
              entry.reference === reference &&
              entry.owner === owner &&
              BigInt(entry.delta) === delta &&
              entry.reason === 'job_funding',
          )
        if (
          price <= 0n ||
          total > BigInt(Number.MAX_SAFE_INTEGER) ||
          priceJob(price).total !== total ||
          outlay <= 0n ||
          outlay >= 1n << 256n ||
          balances.length !== 2 ||
          escrowBalance < total ||
          entries.length !== 2 ||
          !exact(`${funding}:out`, buyer, -total) ||
          !exact(`${funding}:in`, ESCROW_ACCOUNT, total)
        )
          throw review()
        const marker = markerFor(price, total, outlay)
        const marked =
          events.some((event) => event.detail.includes('atomic_job_funding_v1')) ||
          entries.some((entry) => entry.detail.atomicFundingVersion !== undefined)
        if (
          marked &&
          (events.length !== 1 ||
            events[0]?.detail !== marker ||
            spent < outlay ||
            entries.some(
              (entry) => entry.detail.jobId !== job.id || entry.detail.atomicFundingVersion !== 1,
            ))
        )
          throw review()
        // Harmless historical FUNDED readback remains compatible. It does not
        // create a marker, transition state, or assert reservation ownership.
        return {
          jobId: job.id,
          agentId: job.sold_agent_id,
          held: Number(total),
          buyerBalance: Number(payerBalance),
          status: 'FUNDED',
          alreadyFunded: true,
          ...(!marked ? { historicalReadback: true as const } : {}),
        }
      }
      if (input.price === undefined) return null
      if (typeof input.price !== 'bigint' || input.price <= 0n || input.price >= 1n << 256n)
        throw review()
      const pricePoints = pointsForSettlement(input.price, SETTLEMENT.decimals)
      if (!Number.isSafeInteger(pricePoints) || pricePoints <= 0) throw review()
      const points = priceJob(BigInt(pricePoints)).total,
        outlay = priceJob(input.price).total
      if (
        points > BigInt(Number.MAX_SAFE_INTEGER) ||
        outlay >= 1n << 256n ||
        spent + outlay >= 1n << 256n
      )
        throw review()
      const verdict = evaluate(toAuthorization(authorization), outlay)
      if (!verdict.allow)
        throw new ClientError(verdict.reason, { statusCode: 403, code: 'MANDATE_REFUSED' })
      if (verdict.spend !== outlay) throw review()
      if (payerBalance < points)
        throw new ClientError(
          `This job costs ${points} points and the balance is ${payerBalance}.`,
          {
            statusCode: 402,
            code: 'INSUFFICIENT_POINTS',
          },
        )
      if (balances.length !== 2 || escrowBalance + points > BigInt(Number.MAX_SAFE_INTEGER))
        throw review()
      const detail = tx.json({ jobId: job.id, atomicFundingVersion: 1 })
      await tx`
        INSERT INTO credit_entries (id, owner, delta, reason, reference, detail) VALUES
          (${randomUUID()}, ${buyer}, ${(-points).toString()}, 'job_funding', ${`${funding}:out`}, ${detail}),
          (${randomUUID()}, ${ESCROW_ACCOUNT}, ${points.toString()}, 'job_funding', ${`${funding}:in`}, ${detail})
      `
      await tx`
        UPDATE credit_balances SET balance = balance + CASE WHEN owner = ${buyer}
          THEN ${(-points).toString()}::bigint ELSE ${points.toString()}::bigint END, updated_at = now()
        WHERE owner = ANY(${owners})
      `
      await tx`UPDATE authorizations SET spent = spent + ${outlay.toString()}::numeric WHERE id = ${job.authorization_id}`
      await tx`
        UPDATE jobs SET status = 'FUNDED', sold_agent_id = ${input.agentId},
          sold_price_points = ${pricePoints}, sold_total_points = ${points.toString()},
          sold_outlay = ${outlay.toString()}, updated_at = now() WHERE id = ${job.id}
      `
      await tx`
        INSERT INTO job_events (job_id, type, detail, at) VALUES
          (${job.id}, 'spend', ${markerFor(BigInt(pricePoints), points, outlay)}, now()),
          (${job.id}, 'status', 'Original funding committed atomically.', now())
      `
      return {
        jobId: job.id,
        agentId: input.agentId,
        held: Number(points),
        buyerBalance: Number(payerBalance - points),
        status: 'FUNDED',
        alreadyFunded: false,
      }
    })
  }

  async refundFundedJob(input: JobRefundInput): Promise<JobRefundResult | null> {
    const review = () =>
      new ClientError('This job needs a ledger review before any refund can be confirmed.', {
        statusCode: 409,
        code: 'JOB_REFUND_REVIEW_REQUIRED',
      })
    return this.sql.begin(async (tx) => {
      // Serialize against the settlement claim before touching the shared escrow.
      const [job] = await tx<JobRow[]>`SELECT * FROM jobs WHERE id = ${input.jobId} FOR UPDATE`
      if (!job || !['FUNDED', 'CANCELLED'].includes(job.status)) return null
      if (
        job.sold_agent_id === null ||
        job.sold_total_points === null ||
        job.sold_price_points === null ||
        job.sold_outlay === null
      )
        throw review()
      const points = BigInt(job.sold_total_points),
        price = BigInt(job.sold_price_points),
        outlay = BigInt(job.sold_outlay),
        buyer = input.buyer.toLowerCase()
      if (
        points <= 0n ||
        points > BigInt(Number.MAX_SAFE_INTEGER) ||
        price <= 0n ||
        price > points ||
        outlay <= 0n ||
        outlay >= 1n << 256n ||
        !/^0x[0-9a-f]{40}$/.test(buyer)
      )
        throw review()
      const funding = `job:${job.id}:funding`,
        refund = `job:${job.id}:refund`,
        marker = JSON.stringify({
          kind: 'atomic_job_refund_v1',
          jobId: job.id,
          authorizationId: job.authorization_id,
          buyer,
          points: points.toString(),
          outlay: outlay.toString(),
        })
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
        WHERE reference = ANY(${[
          `${funding}:out`,
          `${funding}:in`,
          refund,
          `${refund}:out`,
          `${refund}:in`,
          ...['job_earnings', 'platform_fee'].flatMap((reason) =>
            ['', ':out', ':in'].map((suffix) => `job:${job.id}:${reason}${suffix}`),
          ),
        ]})
      `
      const exact = (reference: string, owner: string, delta: bigint, reason: string) => {
        const row = entries.find((entry) => entry.reference === reference)
        return !!row && row.owner === owner && BigInt(row.delta) === delta && row.reason === reason
      }
      if (
        !exact(`${funding}:out`, buyer, -points, 'job_funding') ||
        !exact(`${funding}:in`, ESCROW_ACCOUNT, points, 'job_funding') ||
        entries.some(
          (entry) =>
            entry.reference.includes(':job_earnings') || entry.reference.includes(':platform_fee'),
        )
      )
        throw review()
      // Same lock order as credit transfers, then the mandate reservation.
      const owners = [buyer, ESCROW_ACCOUNT].sort()
      const balances = await tx<{ owner: string; balance: string }[]>`
        SELECT owner, balance::text FROM credit_balances
        WHERE owner = ANY(${owners}) ORDER BY owner FOR UPDATE
      `
      const [authorization] = await tx<AuthorizationRow[]>`
        SELECT * FROM authorizations WHERE id = ${job.authorization_id} FOR UPDATE
      `
      if (authorization?.owner?.toLowerCase() !== buyer) throw review()
      const markers = await tx`
        SELECT seq FROM job_events WHERE job_id = ${job.id} AND type = 'spend' AND detail = ${marker}
      `
      if (job.status === 'CANCELLED') {
        // Historical cancellation/refund writes did not atomically release the cap.
        // Neither their status nor their credit entries alone prove a safe replay.
        if (
          markers.length !== 1 ||
          entries.length !== 4 ||
          !exact(`${refund}:out`, ESCROW_ACCOUNT, -points, 'job_refund') ||
          !exact(`${refund}:in`, buyer, points, 'job_refund')
        )
          throw review()
        return { refunded: 0, alreadyRefunded: true }
      }
      // A global spent total cannot identify this job's original reservation:
      // old lost-COMMIT compensation could have already released it. Releasing
      // again would subtract some other job's allowance. Require the proof that
      // funding and this reservation committed together before any new refund.
      const originalMarker = fundingMarker({
        jobId: job.id,
        authorizationId: job.authorization_id,
        buyer,
        agentId: job.sold_agent_id,
        pricePoints: price,
        totalPoints: points,
        outlay,
        policyHash: authorization.policy.hash,
      })
      const original = await tx`
        SELECT seq FROM job_events WHERE job_id=${job.id} AND type='spend' AND detail=${originalMarker}
      `
      if (
        original.length !== 1 ||
        entries.some(
          (entry) => entry.detail.jobId !== job.id || entry.detail.atomicFundingVersion !== 1,
        )
      )
        throw review()
      const escrow = balances.find((balance) => balance.owner === ESCROW_ACCOUNT),
        payer = balances.find((balance) => balance.owner === buyer)
      if (
        entries.length !== 2 ||
        markers.length !== 0 ||
        balances.length !== 2 ||
        !escrow ||
        !payer ||
        BigInt(escrow.balance) < points ||
        BigInt(payer.balance) < 0n ||
        BigInt(payer.balance) + points > BigInt(Number.MAX_SAFE_INTEGER) ||
        BigInt(authorization.spent) < outlay
      )
        throw review()
      const detail = tx.json({
        jobId: job.id,
        because: input.because.slice(0, 200),
        atomicRefundVersion: 1,
      })
      await tx`
        INSERT INTO credit_entries (id, owner, delta, reason, reference, detail) VALUES
          (${randomUUID()}, ${ESCROW_ACCOUNT}, ${(-points).toString()}, 'job_refund', ${`${refund}:out`}, ${detail}),
          (${randomUUID()}, ${buyer}, ${points.toString()}, 'job_refund', ${`${refund}:in`}, ${detail})
      `
      await tx`
        UPDATE credit_balances SET balance = balance + CASE WHEN owner = ${buyer}
          THEN ${points.toString()}::bigint ELSE ${(-points).toString()}::bigint END, updated_at = now()
        WHERE owner = ANY(${owners})
      `
      await tx`UPDATE authorizations SET spent = spent - ${outlay.toString()}::numeric WHERE id = ${job.authorization_id}`
      await tx`UPDATE jobs SET status = 'CANCELLED', updated_at = now() WHERE id = ${job.id}`
      await tx`
        INSERT INTO job_events (job_id, type, detail, at) VALUES
          (${job.id}, 'spend', ${marker}, now()),
          (${job.id}, 'status', ${`Refunded ${points} points to the buyer.`}, now())
      `
      return { refunded: Number(points), alreadyRefunded: false }
    })
  }

  async claimCreditPayment(input: CreditPaymentClaim): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const [job] = await tx<JobRow[]>`SELECT * FROM jobs WHERE id = ${input.jobId} FOR UPDATE`
      const from =
        input.status === 'FUNDED' ? ['AUTHORIZED', 'FUNDED'] : ['FUNDED', 'COMPLETED', 'SETTLED']
      if (!job || !from.includes(job.status)) return false
      const invalid = () =>
        new ClientError('The original unrefunded job payment could not be verified.', {
          statusCode: 409,
          code: 'JOB_PAYMENT_REVIEW_REQUIRED',
        })
      if (
        job.sold_total_points === null ||
        job.sold_price_points === null ||
        job.sold_agent_id === null
      )
        throw invalid()
      const points = BigInt(job.sold_total_points),
        price = BigInt(job.sold_price_points),
        buyer = input.buyer.toLowerCase()
      if (
        points <= 0n ||
        points > BigInt(Number.MAX_SAFE_INTEGER) ||
        price <= 0n ||
        priceJob(price).total !== points ||
        !/^0x[0-9a-f]{40}$/.test(buyer)
      )
        throw invalid()
      const [authorization] = await tx<{ owner: string | null }[]>`
        SELECT owner FROM authorizations WHERE id = ${job.authorization_id} FOR SHARE
      `
      if (authorization?.owner?.toLowerCase() !== buyer) throw invalid()
      const funding = `job:${job.id}:funding`,
        refund = `job:${job.id}:refund`
      const entries = await tx<
        { owner: string; delta: string; reason: string; reference: string }[]
      >`
        SELECT owner, delta::text, reason, reference FROM credit_entries WHERE reference = ANY(${[
          `${funding}:out`,
          `${funding}:in`,
          refund,
          `${refund}:out`,
          `${refund}:in`,
          ...['job_earnings', 'platform_fee'].flatMap((reason) =>
            ['', ':out', ':in'].map((suffix) => `job:${job.id}:${reason}${suffix}`),
          ),
        ]})
      `
      const paid = entries.find((entry) => entry.reference === `${funding}:out`),
        held = entries.find((entry) => entry.reference === `${funding}:in`)
      if (
        !paid ||
        !held ||
        paid.owner !== buyer ||
        held.owner !== ESCROW_ACCOUNT ||
        paid.reason !== 'job_funding' ||
        held.reason !== 'job_funding' ||
        BigInt(paid.delta) !== -points ||
        BigInt(held.delta) !== points ||
        entries.some(
          (entry) => entry.reference === refund || entry.reference.startsWith(`${refund}:`),
        ) ||
        (input.status === 'FUNDED' && entries.length !== 2)
      )
        throw invalid()
      // In particular, a late duplicate funding acknowledgement cannot reopen
      // a CANCELLED/SETTLED job after another request won its row lock.
      if (job.status !== input.status) {
        await tx`UPDATE jobs SET status = ${input.status}, updated_at = now() WHERE id = ${job.id}`
        await tx`INSERT INTO job_events (job_id, type, detail, at)
          VALUES (${job.id}, 'status', ${input.status === 'FUNDED' ? 'Original funding confirmed.' : 'Settlement claimed against original funding.'}, now())`
      }
      return true
    })
  }

  async requestApproval(
    request: Omit<ApprovalRequest, 'id' | 'status' | 'requestedAt' | 'decidedAt'>,
  ): Promise<ApprovalRequest> {
    /*
     * The partial unique index decides, not a read followed by a write. The
     * runner raises the same action every tick until somebody answers, and two
     * ticks overlapping would otherwise both find nothing pending and both
     * insert. ON CONFLICT DO NOTHING then returns no row, so the existing one
     * is read back and returned: asking again gets the same question.
     */
    const inserted = await this.sql<ApprovalRow[]>`
      INSERT INTO job_approvals
        (id, job_id, authorization_id, target, selector, asset, amount, recipient, reason, status)
      VALUES (${randomUUID()}, ${request.jobId}, ${request.authorizationId},
              ${request.target}, ${request.selector}, ${request.asset},
              ${request.amount.toString()}, ${request.recipient ?? null},
              ${request.reason}, 'pending')
      ON CONFLICT DO NOTHING
      RETURNING *
    `
    const made = inserted[0]
    if (made) return toApproval(made)
    const waiting = await this.sql<ApprovalRow[]>`
      SELECT * FROM job_approvals
       WHERE job_id = ${request.jobId} AND status = 'pending'
         AND lower(target) = lower(${request.target})
         AND lower(selector) = lower(${request.selector})
         AND lower(asset) = lower(${request.asset})
         AND amount = ${request.amount.toString()}
         AND COALESCE(lower(recipient), '') = ${(request.recipient ?? '').toLowerCase()}
       LIMIT 1
    `
    const row = waiting[0]
    if (!row) throw new Error('The approval request could not be recorded or found.')
    return toApproval(row)
  }

  async approvalFor(
    jobId: string,
    action: {
      target: string
      selector: string
      asset: string
      amount: bigint
      recipient?: string | null
    },
  ): Promise<ApprovalRequest | null> {
    const rows = await this.sql<ApprovalRow[]>`
      SELECT * FROM job_approvals
       WHERE job_id = ${jobId} AND status = 'approved'
         AND lower(target) = lower(${action.target})
         AND lower(selector) = lower(${action.selector})
         AND lower(asset) = lower(${action.asset})
         AND amount = ${action.amount.toString()}
         AND COALESCE(lower(recipient), '') = ${(action.recipient ?? '').toLowerCase()}
       ORDER BY requested_at DESC LIMIT 1
    `
    const row = rows[0]
    return row ? toApproval(row) : null
  }

  async approvals(jobId: string): Promise<ApprovalRequest[]> {
    const rows = await this.sql<ApprovalRow[]>`
      SELECT * FROM job_approvals WHERE job_id = ${jobId} ORDER BY requested_at DESC
    `
    return rows.map(toApproval)
  }

  async decideApproval(
    id: string,
    from: ApprovalRequest['status'][],
    to: ApprovalRequest['status'],
  ): Promise<ApprovalRequest | null> {
    // One conditional UPDATE, so two clicks cannot both land and a decline
    // racing an approve has exactly one winner.
    const rows = await this.sql<ApprovalRow[]>`
      UPDATE job_approvals SET status = ${to}, decided_at = now()
       WHERE id = ${id} AND status = ANY(${from})
      RETURNING *
    `
    const row = rows[0]
    return row ? toApproval(row) : null
  }

  async attemptSpend(
    authorizationId: string,
    evaluate: (authorization: AuthorizationRecord) => SpendVerdict,
  ) {
    return this.sql.begin(async (tx) => {
      const rows = await tx<AuthorizationRow[]>`
        SELECT * FROM authorizations WHERE id = ${authorizationId} FOR UPDATE
      `
      const row = rows[0]
      if (!row) return null
      const verdict = evaluate(toAuthorization(row))
      if (verdict.allow)
        await tx`
          UPDATE authorizations SET spent = spent + ${verdict.spend.toString()}
          WHERE id = ${authorizationId}
        `
      return verdict
    }) as Promise<SpendVerdict | null>
  }

  /**
   * One conditional UPDATE, so exactly one caller wins.
   *
   * `WHERE status = ANY(from)` is the whole guard: two callers racing to pay out
   * of the same escrow both match the read but only one matches the write.
   */
  async claim(jobId: string, from: JobStatus[], to: JobStatus, detail: string) {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        UPDATE jobs SET status = ${to}, updated_at = now()
         WHERE id = ${jobId} AND status = ANY(${from})
        RETURNING id
      `
      if (rows.length === 0) return false
      await tx`
        INSERT INTO job_events (job_id, type, detail, at)
        VALUES (${jobId}, 'status', ${detail}, now())
      `
      return true
    })
  }

  /**
   * Fix the terms, once.
   *
   * The WHERE clause is the guard: it only matches a job that has not been sold
   * yet, so two funders racing cannot both write terms, and the caller is told
   * which one lost rather than the second quietly overwriting the first.
   */
  async recordSale(
    jobId: string,
    sale: { agentId: string; pricePoints: number; totalPoints: number; outlay: bigint },
  ) {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE jobs
         SET sold_agent_id = ${sale.agentId},
             sold_price_points = ${sale.pricePoints},
             sold_total_points = ${sale.totalPoints},
             sold_outlay = ${sale.outlay.toString()},
             updated_at = now()
       WHERE id = ${jobId} AND sold_agent_id IS NULL
      RETURNING id
    `
    if (rows.length === 0)
      throw new ClientError('This job has already been sold.', {
        statusCode: 409,
        code: 'JOB_ALREADY_FUNDED',
      })
  }

  private async hydrate(row: JobRow): Promise<JobRecord> {
    const events = await this.sql<EventRow[]>`
      SELECT type, detail, at FROM job_events WHERE job_id = ${row.id} ORDER BY seq
    `
    return {
      id: row.id,
      authorizationId: row.authorization_id,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      createdAt: iso(row.created_at),
      ...(row.sold_agent_id && row.sold_price_points !== null && row.sold_total_points !== null
        ? {
            sale: {
              agentId: row.sold_agent_id,
              // BIGINT arrives as a string; every comparison downstream is
              // numeric, and a string here compares as text.
              pricePoints: Number(row.sold_price_points),
              totalPoints: Number(row.sold_total_points),
              /*
               * Read as a string and parsed, never through Number. A uint256
               * amount loses precision the moment it becomes a float, and the
               * number this one feeds is a spend cap.
               */
              outlay: BigInt(row.sold_outlay ?? 0),
            },
          }
        : {}),
      events: events.map((event) => ({
        type: event.type,
        detail: event.detail,
        at: iso(event.at),
      })),
    }
  }

  async close() {
    await this.sql.end()
  }
}
