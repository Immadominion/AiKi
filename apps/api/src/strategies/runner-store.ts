import { randomUUID } from 'node:crypto'
import type { StrategyBinding } from '@aiki/contracts/strategies'
import type postgres from 'postgres'
import type { Hex } from 'viem'
import { nonzeroAddress, nonzeroHash } from './operation.js'
import { strategyJSON } from './runner-policy.js'
import { strategyRunnerReadinessDigest } from './runner-readiness.js'

export interface StrategyWatchView {
  id: string
  jobId: string
  authorizationId: string
  chainId: 56
  kind: StrategyBinding['kind']
  vault: Hex
  controller: Hex
  policyHash: Hex
  runtimeCodeHash: Hex
  bindingEnforcer: Hex
  status: 'PAUSED' | 'ACTIVE' | 'NEEDS_REVIEW' | 'CLOSED'
  revision: string
  nonce: string
  expiresAt: string
  lastRunAt: string | null
  nextRunAt: string
  code: string | null
  reason: string | null
  snapshot: postgres.JSONValue | null
  checkpoint: postgres.JSONValue
  policy: postgres.JSONValue
  gasLimitWei: string
  lastTransactionHash: Hex | null
}
export interface StrategyRunnerClaim {
  watchId: string
  leaseId: string
  revision: string
  owner: Hex
  authorizationId: string
  authorizationStatus: string
  authorizationExpiresAt: string | null
  jobStatus: string
  binding: StrategyBinding
  manager: Hex
  executor: Hex
  bindingEnforcer: Hex
  gasLimitWei: bigint
  policy: postgres.JSONValue
  plannerState: postgres.JSONValue
  delegation: unknown
}
interface Row {
  id: string
  job_id: string
  authorization_id: string
  chain_id: 56
  kind: StrategyBinding['kind']
  vault: Hex
  controller: Hex
  policy_hash: Hex
  runtime_code_hash: Hex
  binding_enforcer: Hex
  status: StrategyWatchView['status']
  revision: string
  checkpoint_nonce: string
  expires_at: Date
  last_run_at: Date | null
  next_run_at: Date
  last_run_code: string | null
  last_run_reason: string | null
  chain_snapshot: postgres.JSONValue | null
  checkpoint: postgres.JSONValue
  policy: postgres.JSONValue
  gas_limit_wei: string
  manager: Hex
  executor: Hex
  planner_state: postgres.JSONValue
  runner_lease_id: string
  last_transaction_hash: Hex | null
}
const view = (r: Row): StrategyWatchView => ({
  id: r.id,
  jobId: r.job_id,
  authorizationId: r.authorization_id,
  chainId: 56,
  kind: r.kind,
  vault: r.vault,
  controller: r.controller,
  policyHash: r.policy_hash,
  runtimeCodeHash: r.runtime_code_hash,
  bindingEnforcer: r.binding_enforcer,
  status: r.status,
  revision: String(r.revision),
  nonce: String(r.checkpoint_nonce),
  expiresAt: r.expires_at.toISOString(),
  lastRunAt: r.last_run_at?.toISOString() ?? null,
  nextRunAt: r.next_run_at.toISOString(),
  code: r.last_run_code,
  reason: r.last_run_reason,
  snapshot: r.chain_snapshot,
  checkpoint: r.checkpoint,
  policy: r.policy,
  gasLimitWei: String(r.gas_limit_wei),
  lastTransactionHash: r.last_transaction_hash ?? null,
})
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/** Durable scheduling is separate from the economic execution store and never holds a signer. */
export class PostgresStrategyRunnerStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getWatchForOwner(watchId: string, owner: Hex): Promise<StrategyWatchView | null> {
    if (!uuid(watchId) || !nonzeroAddress(owner)) return null
    const [row] = await this.sql<Row[]>`SELECT w.*,
      (SELECT e.transaction_hash FROM strategy_operations o JOIN execution_attempts e ON e.id=o.attempt_id
        WHERE o.watch_id=w.id AND o.state IN ('LANDED','REVERTED') AND e.state=o.state AND o.verified_receipt IS NOT NULL
        ORDER BY o.completed_at DESC,o.attempt_id DESC LIMIT 1) AS last_transaction_hash
      FROM strategy_watches w JOIN authorizations a ON a.id = w.authorization_id
      WHERE w.id = ${watchId} AND a.owner = ${owner.toLowerCase()}`
    return row ? view(row) : null
  }

  async listForOwner(owner: Hex): Promise<StrategyWatchView[]> {
    if (!nonzeroAddress(owner)) return []
    return (
      await this.sql<Row[]>`SELECT w.*,
      (SELECT e.transaction_hash FROM strategy_operations o JOIN execution_attempts e ON e.id=o.attempt_id
        WHERE o.watch_id=w.id AND o.state IN ('LANDED','REVERTED') AND e.state=o.state AND o.verified_receipt IS NOT NULL
        ORDER BY o.completed_at DESC,o.attempt_id DESC LIMIT 1) AS last_transaction_hash
      FROM strategy_watches w JOIN authorizations a ON a.id = w.authorization_id
      WHERE a.owner = ${owner.toLowerCase()} ORDER BY w.created_at DESC, w.id DESC LIMIT 100`
    ).map(view)
  }

  async schedulerStatus(
    configurationHash: Hex,
    executor: Hex,
  ): Promise<{ ready: boolean; lastSeenAt: string | null; reason: string }> {
    if (!nonzeroHash(configurationHash) || !nonzeroAddress(executor))
      return {
        ready: false,
        lastSeenAt: null,
        reason: 'Strategy configuration or executor is unavailable.',
      }
    const readinessHash = strategyRunnerReadinessDigest(configurationHash, executor)
    const [row] = await this.sql<
      { ready: boolean; seen_at: Date; reason: string; configuration_hash: Hex; fresh: boolean }[]
    >`
      SELECT *, (seen_at <= now() AND seen_at >= now() - interval '120 seconds') AS fresh
      FROM strategy_runner_heartbeat WHERE chain_id = 56`
    const ready = !!row?.ready && row.fresh && row.configuration_hash === readinessHash
    return {
      ready,
      lastSeenAt: row?.seen_at.toISOString() ?? null,
      reason: ready
        ? 'Strategy runner is ready.'
        : 'Strategy runner is not ready. No automation will start.',
    }
  }

  async heartbeat(input: {
    instanceId: string
    configurationHash: Hex
    executor?: Hex
    ready: boolean
    reason: string
  }): Promise<void> {
    if (
      !uuid(input.instanceId) ||
      !nonzeroHash(input.configurationHash) ||
      (input.executor !== undefined && !nonzeroAddress(input.executor)) ||
      (input.ready && !nonzeroAddress(input.executor)) ||
      typeof input.ready !== 'boolean' ||
      typeof input.reason !== 'string' ||
      input.reason.length > 240
    )
      throw new Error('Invalid strategy runner heartbeat.')
    // Existing column now stores the executor-bound readiness identity, NOT the public
    // deployment digest. Legacy raw-digest heartbeats fail closed without a migration.
    // Recovery-only unavailable workers may publish without an execution identity.
    const readinessHash = input.executor
      ? strategyRunnerReadinessDigest(input.configurationHash, input.executor)
      : input.configurationHash.toLowerCase()
    await this
      .sql`INSERT INTO strategy_runner_heartbeat(chain_id,instance_id,configuration_hash,ready,reason)
      VALUES (56,${input.instanceId},${readinessHash},${input.ready},${input.reason})
      ON CONFLICT (chain_id) DO UPDATE SET instance_id=EXCLUDED.instance_id,configuration_hash=EXCLUDED.configuration_hash,
        ready=EXCLUDED.ready,reason=EXCLUDED.reason,seen_at=now()`
  }

  async listPendingAttemptIds(limit = 50): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid recovery page size.')
    return (
      await this.sql<
        { id: string }[]
      >`SELECT e.id FROM execution_attempts e JOIN strategy_operations o ON o.attempt_id=e.id
      JOIN strategy_watches w ON w.id=o.watch_id
      WHERE e.purpose='strategy' AND e.state IN ('PREPARING','SUBMITTED','UNCONFIRMED') AND o.state='PENDING'
        AND e.updated_at < now() - interval '120 seconds'
        AND (w.runner_lease_until IS NULL OR w.runner_lease_until <= now())
      ORDER BY e.updated_at,e.id LIMIT ${limit}`
    ).map((r) => r.id)
  }

  /** A lease prevents redundant planning. It never releases or substitutes an execution nonce lock. */
  async claimDue(limit = 10, leaseSeconds = 90): Promise<StrategyRunnerClaim[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 30 ||
      leaseSeconds > 300
    )
      throw new Error('Invalid strategy scheduler bounds.')
    const leaseId = randomUUID()
    const rows = await this.sql<
      (Row & {
        owner: Hex
        authorization_status: string
        authorization_expiry: Date | null
        job_status: string
        delegation: unknown
      })[]
    >`
      WITH due AS (
        SELECT w.id FROM strategy_watches w WHERE w.status='ACTIVE' AND w.next_run_at <= now()
          AND (w.runner_lease_until IS NULL OR w.runner_lease_until <= now())
          AND NOT EXISTS (SELECT 1 FROM execution_attempts e WHERE e.authorization_id=w.authorization_id
            AND e.state IN ('PREPARING','SUBMITTED','UNCONFIRMED'))
        ORDER BY w.next_run_at,w.id FOR UPDATE SKIP LOCKED LIMIT ${limit}
      ), claimed AS (
        UPDATE strategy_watches w SET runner_lease_id=${leaseId},runner_lease_until=now()+${leaseSeconds}*interval '1 second'
        FROM due WHERE w.id=due.id RETURNING w.*
      ) SELECT w.*,a.owner,a.status AS authorization_status,a.expires_at AS authorization_expiry,a.delegation,j.status AS job_status
        FROM claimed w JOIN authorizations a ON a.id=w.authorization_id JOIN jobs j ON j.id=w.job_id`
    return rows.map((r) => ({
      watchId: r.id,
      leaseId: r.runner_lease_id,
      revision: String(r.revision),
      owner: r.owner,
      authorizationId: r.authorization_id,
      authorizationStatus: r.authorization_status,
      authorizationExpiresAt: r.authorization_expiry?.toISOString() ?? null,
      jobStatus: r.job_status,
      binding: {
        version: 1,
        chainId: 56,
        kind: r.kind,
        vault: r.vault,
        controller: r.controller,
        policyHash: r.policy_hash,
        runtimeCodeHash: r.runtime_code_hash,
      },
      manager: r.manager,
      executor: r.executor,
      bindingEnforcer: r.binding_enforcer,
      gasLimitWei: BigInt(r.gas_limit_wei),
      policy: r.policy,
      plannerState: r.planner_state,
      delegation: r.delegation,
    }))
  }

  async savePlannerState(input: {
    watchId: string
    leaseId: string
    expectedRevision: string
    state: unknown
  }): Promise<string | null> {
    if (!uuid(input.watchId) || !uuid(input.leaseId) || !/^\d+$/.test(input.expectedRevision))
      throw new Error('Invalid planner checkpoint.')
    const state = JSON.parse(strategyJSON(input.state)) as postgres.JSONValue
    const [row] = await this.sql<
      { revision: string }[]
    >`UPDATE strategy_watches w SET planner_state=${this.sql.json(state)},revision=revision+1,updated_at=now()
      WHERE id=${input.watchId} AND revision=${input.expectedRevision} AND status='ACTIVE' AND runner_lease_id=${input.leaseId}
        AND runner_lease_until>now() AND NOT EXISTS (SELECT 1 FROM execution_attempts e WHERE e.authorization_id=w.authorization_id
          AND e.state IN ('PREPARING','SUBMITTED','UNCONFIRMED')) RETURNING revision`
    return row ? String(row.revision) : null
  }

  async finishPass(input: {
    watchId: string
    leaseId: string
    code: string
    reason: string
    intervalSeconds: number
    stop?: boolean
  }): Promise<boolean> {
    if (
      !uuid(input.watchId) ||
      !uuid(input.leaseId) ||
      !/^[A-Z_]{1,60}$/.test(input.code) ||
      typeof input.reason !== 'string' ||
      input.reason.length > 240 ||
      !Number.isInteger(input.intervalSeconds) ||
      input.intervalSeconds < 5 ||
      input.intervalSeconds > 3600
    )
      throw new Error('Invalid strategy pass outcome.')
    return this.sql.begin(async (tx) => {
      const [held] = await tx<
        Row[]
      >`SELECT * FROM strategy_watches WHERE id=${input.watchId} AND runner_lease_id=${input.leaseId} FOR UPDATE`
      if (!held) return false
      await tx`UPDATE strategy_watches SET last_run_at=now(),last_run_code=${input.code},last_run_reason=${input.reason},
        next_run_at=now()+${input.intervalSeconds}*interval '1 second',runner_lease_id=NULL,runner_lease_until=NULL,
        status=CASE WHEN ${input.stop === true} AND status='ACTIVE' THEN 'NEEDS_REVIEW' ELSE status END,
        revision=revision+CASE WHEN ${input.stop === true} AND status='ACTIVE' THEN 1 ELSE 0 END,updated_at=now() WHERE id=${input.watchId}`
      if (held.last_run_code !== input.code || held.last_run_reason !== input.reason)
        await tx`INSERT INTO job_events(job_id,type,detail,at) VALUES (${held.job_id},'status',${input.reason},now())`
      return true
    })
  }
}
