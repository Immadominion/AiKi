import { randomUUID } from 'node:crypto'
import type { StrategyBinding } from '@aiki/contracts/strategies'
import type postgres from 'postgres'
import { type Hex, keccak256 } from 'viem'
import {
  assertStrategyEnvelope,
  decodeStoredStrategyDelegation,
  encodeStrategyEnvelope,
} from './envelope.js'
import { assertStrategyGrant } from './grant.js'
import {
  decodeStoredStrategyOperation,
  encodeStrategyOperation,
  nonzeroAddress,
  nonzeroHash,
  type StrategyOperation,
  strategyOperationDigest,
  validateStrategyBinding,
} from './operation.js'
import { isVerifiedStrategyReceipt, type VerifiedStrategyReceipt } from './receipt.js'
import { isVerifiedStrategySimulation, type StrategySimulationQuote } from './simulation.js'
import { isVerifiedStrategySnapshot, type VerifiedStrategySnapshot } from './snapshot.js'
import { operationMatchesStoredSnapshot } from './stored-state.js'

const json = (value: unknown): postgres.JSONValue =>
  JSON.parse(
    JSON.stringify(value, (_key, child) => (typeof child === 'bigint' ? child.toString() : child)),
  )
const lower = (value: string) => value.toLowerCase()
const pending = ['PREPARING', 'SUBMITTED', 'UNCONFIRMED']

interface WatchRow {
  id: string
  authorization_id: string
  job_id: string
  chain_id: number
  vault: Hex
  controller: Hex
  policy_hash: Hex
  runtime_code_hash: Hex
  kind: StrategyBinding['kind']
  manager: Hex
  executor: Hex
  binding_enforcer: Hex
  status: 'PAUSED' | 'ACTIVE' | 'NEEDS_REVIEW' | 'CLOSED'
  revision: string
  checkpoint_nonce: string
  expires_at: Date
  checkpoint: postgres.JSONValue
  policy: postgres.JSONValue
  gas_limit_wei: string
  snapshot_block: string | null
  snapshot_hash: Hex | null
  snapshot_timestamp: Date | null
  chain_snapshot: postgres.JSONValue | null
}
interface JoinedWatch extends WatchRow {
  authorization_status: string
  authorization_expiry: Date | null
  delegation: { delegate?: string; delegator?: string } | null
  delegator: string | null
  delegation_chain_id: number | null
  job_status: string
  now_seconds: string
}
interface AttemptRow {
  id: string
  state: string
  purpose: string
  transaction_hash: Hex | null
  authorization_id: string
  job_id: string
  chain_id: number
  executor_address: Hex
}
interface OperationRow {
  attempt_id: string
  watch_id: string
  expected_nonce: string
  watch_revision: string
  operation_digest: Hex
  call_data_hash: Hex
  envelope_hash: Hex
  gas_limit_wei: string
  state: string
  operation: postgres.JSONValue
}

/** No signer or RPC lives here. Normal settlement and recovery share the same atomic method. */
export class PostgresStrategyStore {
  constructor(private readonly sql: postgres.Sql) {}

  /** Recovery can inspect one already-prepared attempt, but cannot change or resend its intent. */
  async getPendingAttempt(attemptId: string): Promise<{
    attemptId: string
    operation: StrategyOperation
    transactionHash: Hex | null
    manager: Hex
    executor: Hex
    envelopeHash: Hex
  } | null> {
    const [row] = await this.sql<
      (OperationRow & { transaction_hash: Hex | null; manager: Hex; executor: Hex })[]
    >`
      SELECT o.*, e.transaction_hash, w.manager, w.executor
      FROM strategy_operations o JOIN execution_attempts e ON e.id = o.attempt_id JOIN strategy_watches w ON w.id = o.watch_id
      WHERE o.attempt_id = ${attemptId} AND o.state = 'PENDING' AND e.purpose = 'strategy'
        AND e.state IN ('PREPARING','SUBMITTED','UNCONFIRMED') AND e.authorization_id = w.authorization_id
        AND e.job_id = w.job_id AND e.executor_address = w.executor AND e.chain_id = 56 AND w.chain_id = 56`
    if (!row) return null
    const operation = decodeStoredStrategyOperation(row.operation)
    if (
      strategyOperationDigest(operation) !== row.operation_digest ||
      keccak256(encodeStrategyOperation(operation)) !== row.call_data_hash ||
      operation.expectedNonce.toString() !== String(row.expected_nonce) ||
      !nonzeroAddress(row.manager) ||
      !nonzeroAddress(row.executor) ||
      !nonzeroHash(row.envelope_hash) ||
      (row.transaction_hash !== null && !nonzeroHash(row.transaction_hash))
    )
      throw new Error('Stored strategy recovery intent does not match its immutable digest.')
    return {
      attemptId,
      operation,
      transactionHash: row.transaction_hash,
      manager: row.manager,
      executor: row.executor,
      envelopeHash: row.envelope_hash,
    }
  }

  /** Refresh complete chain state under a revision lock. Only an explicit owner request can start/restart. */
  async syncSnapshot(input: {
    watchId: string
    expectedRevision: string
    snapshot: VerifiedStrategySnapshot
    activateOwner?: Hex
  }): Promise<
    | { status: 'applied'; revision: string; active: boolean }
    | { status: 'changed' | 'pending' | 'not_ready' }
  > {
    const { watchId, expectedRevision, snapshot, activateOwner } = input
    if (!isVerifiedStrategySnapshot(snapshot) || !/^\d+$/.test(expectedRevision))
      throw new Error('A fresh verified strategy snapshot is required.')
    return this.sql.begin(async (tx) => {
      const [watch] = await tx<
        (WatchRow & {
          owner: string
          authorization_status: string
          authorization_expiry: Date | null
          now_seconds: string
        })[]
      >`
        SELECT w.*, a.owner, a.status AS authorization_status, a.expires_at AS authorization_expiry,
          floor(extract(epoch FROM now()))::text AS now_seconds
        FROM strategy_watches w JOIN authorizations a ON a.id = w.authorization_id
        WHERE w.id = ${watchId} FOR UPDATE OF w, a`
      if (!watch || String(watch.revision) !== expectedRevision || watch.status === 'CLOSED')
        return { status: 'changed' } as const
      const b = snapshot.binding
      if (
        watch.vault !== lower(b.vault) ||
        watch.controller !== lower(b.controller) ||
        watch.kind !== b.kind ||
        watch.policy_hash !== lower(b.policyHash) ||
        watch.runtime_code_hash !== lower(b.runtimeCodeHash) ||
        watch.manager !== lower(snapshot.manager) ||
        watch.binding_enforcer !== snapshot.bindingEnforcer.address ||
        watch.owner !== lower(snapshot.owner)
      )
        return { status: 'changed' } as const
      const now = BigInt(watch.now_seconds)
      if (
        snapshot.block.timestamp > now ||
        now - snapshot.block.timestamp > 30n ||
        snapshot.nonce < BigInt(watch.checkpoint_nonce) ||
        (watch.snapshot_block !== null &&
          (snapshot.block.number < BigInt(watch.snapshot_block) ||
            (snapshot.block.number === BigInt(watch.snapshot_block) &&
              lower(snapshot.block.hash) !== watch.snapshot_hash)))
      )
        return { status: 'not_ready' } as const
      const pendingAttempt =
        await tx`SELECT id FROM execution_attempts WHERE authorization_id = ${watch.authorization_id}
        AND state IN ('PREPARING','SUBMITTED','UNCONFIRMED') LIMIT 1`
      if (pendingAttempt.length) return { status: 'pending' } as const
      const s = snapshot.state
      const funded =
        s.kind === 'yield'
          ? s.managedIdle > 0n || s.managedVenusShares > 0n || s.managedAaveScaled > 0n
          : s.kind === 'grid'
            ? s.allocated0 > 0n || s.allocated1 > 0n
            : s.enrolled &&
              s.currentTokenId > 0n &&
              s.positionLiquidity > 0n &&
              s.position?.owner === watch.vault
      const ready =
        !snapshot.paused &&
        snapshot.expiresAt > now &&
        funded &&
        watch.authorization_status === 'active' &&
        !!watch.authorization_expiry &&
        watch.authorization_expiry.getTime() > Number(now) * 1000 &&
        watch.expires_at.getTime() === Number(snapshot.expiresAt) * 1000
      if (activateOwner !== undefined && (lower(activateOwner) !== watch.owner || !ready))
        return { status: 'not_ready' } as const
      const status =
        activateOwner !== undefined
          ? 'ACTIVE'
          : watch.status === 'ACTIVE' && !ready
            ? 'PAUSED'
            : watch.status
      await tx`UPDATE strategy_watches SET chain_snapshot = ${tx.json(json(snapshot))}, snapshot_block = ${snapshot.block.number.toString()},
        snapshot_hash = ${lower(snapshot.block.hash)},
        snapshot_timestamp = to_timestamp(${snapshot.block.timestamp.toString()}::double precision),
        checkpoint_nonce = ${snapshot.nonce.toString()}, status = ${status}, revision = revision + 1, updated_at = now()
        WHERE id = ${watchId}`
      if (activateOwner !== undefined)
        await tx`INSERT INTO job_events (job_id, type, detail, at)
        VALUES (${watch.job_id}, 'status', 'Strategy started with the owner-approved limits.', now())`
      return {
        status: 'applied',
        revision: (BigInt(expectedRevision) + 1n).toString(),
        active: status === 'ACTIVE',
      } as const
    })
  }

  /** Registration is inert. Funding, signing or creating a record never activates a watch. */
  async registerPaused(request: {
    jobId: string
    binding: StrategyBinding
    manager: Hex
    executor: Hex
    bindingEnforcer: Hex
    expiresAt: string
    policy: postgres.JSONValue
    gasLimitWei: bigint
  }): Promise<string> {
    const input = structuredClone(request)
    validateStrategyBinding(input.binding)
    if (
      !nonzeroAddress(input.manager) ||
      !nonzeroAddress(input.executor) ||
      !nonzeroAddress(input.bindingEnforcer) ||
      typeof input.gasLimitWei !== 'bigint' ||
      input.gasLimitWei <= 0n ||
      input.gasLimitWei >= 1n << 256n ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) % 1000 !== 0
    )
      throw new Error('Invalid strategy registration.')
    const b = input.binding
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1095322441, 56)`
      const rows = await tx<
        {
          authorization_id: string
          delegator: string | null
          delegation_chain_id: number | null
          delegation: unknown
        }[]
      >`
        SELECT a.id AS authorization_id, a.delegator, a.delegation_chain_id, a.delegation
        FROM jobs j JOIN authorizations a ON a.id = j.authorization_id
        WHERE j.id = ${input.jobId} FOR UPDATE OF a
      `
      const auth = rows[0]
      if (
        !auth ||
        lower(auth.delegator ?? '') !== lower(b.controller) ||
        auth.delegation_chain_id !== 56
      )
        throw new Error('Strategy registration must belong to the signed mandate account.')
      const pendingLegacy = await tx`SELECT id FROM execution_attempts
        WHERE authorization_id = ${auth.authorization_id} AND purpose = 'legacy'
          AND state IN ('PREPARING','SUBMITTED','UNCONFIRMED') LIMIT 1`
      if (pendingLegacy.length)
        throw new Error('An existing execution must be resolved before registering this strategy.')
      const existing = await tx<
        (WatchRow & { policy_matches: boolean })[]
      >`SELECT *, policy = ${tx.json(input.policy)}::jsonb AS policy_matches FROM strategy_watches
        WHERE authorization_id = ${auth.authorization_id} OR (chain_id = 56 AND vault = ${lower(b.vault)})`
      if (existing.length) {
        const row = existing[0]
        if (
          !row ||
          existing.length !== 1 ||
          row.authorization_id !== auth.authorization_id ||
          row.job_id !== input.jobId ||
          row.vault !== lower(b.vault) ||
          row.controller !== lower(b.controller) ||
          row.policy_hash !== lower(b.policyHash) ||
          row.runtime_code_hash !== lower(b.runtimeCodeHash) ||
          row.kind !== b.kind ||
          row.manager !== lower(input.manager) ||
          row.executor !== lower(input.executor) ||
          row.binding_enforcer !== lower(input.bindingEnforcer) ||
          BigInt(row.gas_limit_wei) !== input.gasLimitWei ||
          row.expires_at.getTime() !== Date.parse(input.expiresAt) ||
          !row.policy_matches
        )
          throw new Error('A strategy retry cannot replace its registered configuration.')
        return row.id
      }
      const id = randomUUID()
      assertStrategyGrant({
        delegation: decodeStoredStrategyDelegation(auth.delegation),
        binding: b,
        executor: input.executor,
        bindingEnforcer: input.bindingEnforcer,
      })
      await tx`INSERT INTO strategy_watches
        (id, authorization_id, job_id, chain_id, vault, controller, policy_hash, runtime_code_hash,
         kind, manager, executor, checkpoint_nonce, checkpoint, policy, expires_at, gas_limit_wei, binding_enforcer)
        VALUES (${id}, ${auth.authorization_id}, ${input.jobId}, 56, ${lower(b.vault)}, ${lower(b.controller)},
         ${lower(b.policyHash)}, ${lower(b.runtimeCodeHash)}, ${b.kind}, ${lower(input.manager)}, ${lower(input.executor)},
         0, '{}'::jsonb, ${tx.json(input.policy)}, ${input.expiresAt}, ${input.gasLimitWei.toString()}, ${lower(input.bindingEnforcer)})`
      return id
    })
  }

  /** The runner must refresh verified chain state before every claim; a receipt is not a full snapshot. */
  async begin(request: {
    watchId: string
    expectedRevision: string
    operation: StrategyOperation
    envelopeHash: Hex
    manager: Hex
    executor: Hex
    simulation: StrategySimulationQuote
    gasBudgetWei: bigint
  }): Promise<
    | { acquired: true; attemptId: string }
    | { acquired: false; reason: 'changed' | 'not_ready' | 'pending' }
  > {
    const { simulation, ...prepared } = request
    const input = structuredClone(prepared)
    const callData = encodeStrategyOperation(input.operation)
    if (
      !isVerifiedStrategySimulation(simulation) ||
      simulation.operationDigest !== strategyOperationDigest(input.operation) ||
      simulation.envelopeHash !== input.envelopeHash ||
      typeof input.gasBudgetWei !== 'bigint' ||
      input.gasBudgetWei <= 0n ||
      input.gasBudgetWei >= 1n << 256n ||
      simulation.gasUnits * simulation.gasPriceWei > input.gasBudgetWei ||
      !nonzeroHash(input.envelopeHash) ||
      !nonzeroAddress(input.manager) ||
      !nonzeroAddress(input.executor) ||
      !/^\d+$/.test(input.expectedRevision)
    )
      throw new Error('Invalid prepared operation.')
    const op = input.operation,
      b = op.binding
    return this.sql.begin(async (tx) => {
      // Same lock as legacy Guardian claims. Unknown legacy senders still block this chain.
      await tx`SELECT pg_advisory_xact_lock(1095322441, 56)`
      const rows = await tx<JoinedWatch[]>`
        SELECT w.*, a.status AS authorization_status, a.expires_at AS authorization_expiry, a.delegation,
          a.delegator, a.delegation_chain_id, j.status AS job_status,
          floor(extract(epoch FROM now()))::text AS now_seconds
        FROM strategy_watches w JOIN jobs j ON j.id = w.job_id
          JOIN authorizations a ON a.id = w.authorization_id
        WHERE w.id = ${input.watchId} FOR UPDATE OF w, a
      `
      const w = rows[0]
      if (!w || String(w.revision) !== input.expectedRevision)
        return { acquired: false, reason: 'changed' } as const
      try {
        const delegation = decodeStoredStrategyDelegation(w.delegation)
        assertStrategyGrant({
          delegation,
          binding: b,
          executor: w.executor,
          bindingEnforcer: w.binding_enforcer,
        })
        const envelope = encodeStrategyEnvelope(op, delegation)
        assertStrategyEnvelope(envelope, op, w.executor)
        if (keccak256(envelope) !== lower(input.envelopeHash))
          return { acquired: false, reason: 'changed' } as const
      } catch {
        return { acquired: false, reason: 'not_ready' } as const
      }
      if (
        w.status !== 'ACTIVE' ||
        w.authorization_status !== 'active' ||
        !w.chain_snapshot ||
        !operationMatchesStoredSnapshot(op, w.chain_snapshot) ||
        !w.snapshot_timestamp ||
        w.snapshot_block !== simulation.blockNumber.toString() ||
        w.snapshot_hash !== simulation.blockHash ||
        input.gasBudgetWei > BigInt(w.gas_limit_wei) ||
        w.snapshot_timestamp.getTime() > Number(w.now_seconds) * 1000 ||
        Number(w.now_seconds) * 1000 - w.snapshot_timestamp.getTime() > 30_000 ||
        !['AUTHORIZED', 'RUNNING'].includes(w.job_status) ||
        !w.authorization_expiry ||
        w.expires_at.getTime() <= Number(w.now_seconds) * 1000 ||
        w.authorization_expiry.getTime() <= Number(w.now_seconds) * 1000 ||
        w.delegation_chain_id !== 56 ||
        lower(w.delegator ?? '') !== w.controller ||
        lower(w.delegation?.delegator ?? '') !== w.controller ||
        lower(w.delegation?.delegate ?? '') !== w.executor ||
        op.deadline <= BigInt(w.now_seconds) ||
        op.deadline > BigInt(Math.floor(w.expires_at.getTime() / 1000)) ||
        op.deadline > BigInt(Math.floor(w.authorization_expiry.getTime() / 1000)) ||
        op.deadline - BigInt(w.now_seconds) > 3600n
      )
        return { acquired: false, reason: 'not_ready' } as const
      if (
        w.vault !== lower(b.vault) ||
        w.controller !== lower(b.controller) ||
        w.kind !== b.kind ||
        w.manager !== lower(input.manager) ||
        w.executor !== lower(input.executor) ||
        w.policy_hash !== lower(b.policyHash) ||
        w.runtime_code_hash !== lower(b.runtimeCodeHash) ||
        BigInt(w.checkpoint_nonce) !== op.expectedNonce
      )
        return { acquired: false, reason: 'changed' } as const
      const busy = await tx`SELECT id FROM execution_attempts
        WHERE state IN ('PREPARING','SUBMITTED','UNCONFIRMED') AND
          (authorization_id = ${w.authorization_id} OR
           (chain_id = 56 AND (executor_address IS NULL OR executor_address = ${w.executor}))) LIMIT 1`
      if (busy.length) return { acquired: false, reason: 'pending' } as const
      const attemptId = randomUUID()
      await tx`INSERT INTO execution_attempts
        (id, authorization_id, job_id, chain_id, executor_address, purpose, state)
        VALUES (${attemptId}, ${w.authorization_id}, ${w.job_id}, 56, ${w.executor}, 'strategy', 'PREPARING')`
      await tx`INSERT INTO strategy_operations
        (attempt_id, watch_id, watch_revision, expected_nonce, operation_digest, call_data_hash, envelope_hash, operation, state, gas_limit_wei)
        VALUES (${attemptId}, ${w.id}, ${w.revision}, ${op.expectedNonce.toString()}, ${strategyOperationDigest(op)},
          ${keccak256(callData)}, ${lower(input.envelopeHash)}, ${tx.json(json(op))}, 'PENDING', ${input.gasBudgetWei.toString()})`
      await tx`INSERT INTO job_events (job_id, type, detail, at)
        VALUES (${w.job_id}, 'status', 'Strategy operation prepared. Awaiting verified chain outcome.', now())`
      return { acquired: true, attemptId } as const
    })
  }

  async recordHash(attemptId: string, transactionHash: Hex): Promise<void> {
    if (!nonzeroHash(transactionHash)) throw new Error('Invalid prepared transaction hash.')
    await this.sql.begin(async (tx) => {
      const [row] = await tx<
        AttemptRow[]
      >`SELECT * FROM execution_attempts WHERE id = ${attemptId} FOR UPDATE`
      if (
        row?.purpose !== 'strategy' ||
        !pending.includes(row.state) ||
        (row.transaction_hash && row.transaction_hash !== lower(transactionHash))
      )
        throw new Error('Strategy transaction hash cannot be replaced.')
      if (row.transaction_hash) return
      // Last service-side admission point. A stopped/revoked/changed mandate must not reach broadcast.
      const [operation] = await tx<
        OperationRow[]
      >`SELECT * FROM strategy_operations WHERE attempt_id = ${attemptId} FOR UPDATE`
      const [watch] = await tx<JoinedWatch[]>`
        SELECT w.*, a.status AS authorization_status, a.expires_at AS authorization_expiry, a.delegation,
          a.delegator, a.delegation_chain_id, j.status AS job_status, floor(extract(epoch FROM now()))::text AS now_seconds
        FROM strategy_watches w JOIN authorizations a ON a.id = w.authorization_id JOIN jobs j ON j.id = w.job_id
        WHERE w.id = ${operation?.watch_id ?? null} FOR UPDATE OF w, a, j`
      if (
        !operation ||
        !watch ||
        row.state !== 'PREPARING' ||
        operation.state !== 'PENDING' ||
        watch.status !== 'ACTIVE' ||
        watch.authorization_status !== 'active' ||
        String(watch.revision) !== String(operation.watch_revision) ||
        !['AUTHORIZED', 'RUNNING'].includes(watch.job_status) ||
        watch.delegation_chain_id !== 56 ||
        lower(watch.delegator ?? '') !== watch.controller ||
        !watch.authorization_expiry ||
        watch.authorization_expiry.getTime() <= Number(watch.now_seconds) * 1000 ||
        watch.expires_at.getTime() <= Number(watch.now_seconds) * 1000 ||
        !watch.snapshot_timestamp ||
        watch.snapshot_timestamp.getTime() > Number(watch.now_seconds) * 1000 ||
        Number(watch.now_seconds) * 1000 - watch.snapshot_timestamp.getTime() > 30_000
      )
        throw new Error('Strategy stopped or changed before broadcast admission.')
      const op = decodeStoredStrategyOperation(operation.operation)
      const delegation = decodeStoredStrategyDelegation(watch.delegation)
      assertStrategyGrant({
        delegation,
        binding: op.binding,
        executor: watch.executor,
        bindingEnforcer: watch.binding_enforcer,
      })
      const envelope = encodeStrategyEnvelope(op, delegation)
      assertStrategyEnvelope(envelope, op, watch.executor)
      if (
        keccak256(envelope) !== operation.envelope_hash ||
        strategyOperationDigest(op) !== operation.operation_digest ||
        op.deadline <= BigInt(watch.now_seconds) ||
        !operationMatchesStoredSnapshot(op, watch.chain_snapshot)
      )
        throw new Error('Strategy permission or operation changed before broadcast admission.')
      await tx`UPDATE execution_attempts SET transaction_hash = ${lower(transactionHash)}, state = 'SUBMITTED',
        updated_at = now() WHERE id = ${attemptId}`
    })
  }

  /** Only a known pre-broadcast refusal with no recorded hash may close without a receipt. */
  async refuseBeforeBroadcast(attemptId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [row] = await tx<
        AttemptRow[]
      >`SELECT * FROM execution_attempts WHERE id = ${attemptId} FOR UPDATE`
      if (row?.purpose !== 'strategy' || row.state !== 'PREPARING' || row.transaction_hash)
        throw new Error('Only a known unsubmitted strategy operation may be refused.')
      await tx`UPDATE strategy_operations SET state = 'REFUSED', completed_at = now()
        WHERE attempt_id = ${attemptId} AND state = 'PENDING'`
      await tx`UPDATE strategy_watches SET status = CASE WHEN status = 'CLOSED' THEN status ELSE 'NEEDS_REVIEW' END,
        revision = revision + 1, updated_at = now()
        WHERE id = (SELECT watch_id FROM strategy_operations WHERE attempt_id = ${attemptId})`
      await tx`UPDATE execution_attempts SET state = 'REFUSED', updated_at = now() WHERE id = ${attemptId}`
      await tx`INSERT INTO job_events (job_id, type, detail, at)
        VALUES (${row.job_id}, 'status', 'Strategy transaction was not submitted. Review setup before restarting.', now())`
    })
  }

  /** A missing/ambiguous hash never permits another send or an automatic refund. */
  async requireReview(attemptId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [attempt] = await tx<
        AttemptRow[]
      >`SELECT * FROM execution_attempts WHERE id = ${attemptId} FOR UPDATE`
      if (attempt?.purpose !== 'strategy' || !pending.includes(attempt.state)) return
      await tx`UPDATE execution_attempts SET state = 'UNCONFIRMED', updated_at = now() WHERE id = ${attemptId}`
      await tx`UPDATE strategy_watches SET status = CASE WHEN status = 'CLOSED' THEN status ELSE 'NEEDS_REVIEW' END,
        revision = revision + 1, updated_at = now()
        WHERE id = (SELECT watch_id FROM strategy_operations WHERE attempt_id = ${attemptId})`
    })
  }

  /** Owner's service-side stop is immediate; any pending chain transaction remains tracked. */
  async pause(watchId: string, owner: Hex): Promise<boolean> {
    const rows = await this
      .sql`UPDATE strategy_watches w SET status = 'PAUSED', revision = revision + 1, updated_at = now()
      FROM authorizations a WHERE w.id = ${watchId} AND a.id = w.authorization_id AND a.owner = ${lower(owner)}
      AND w.status IN ('ACTIVE','NEEDS_REVIEW') RETURNING w.id`
    return rows.length === 1
  }

  /** Terminal attempt + immutable receipt + transaction-local checkpoint commit or roll back together. */
  async settle(
    attemptId: string,
    evidence: VerifiedStrategyReceipt,
  ): Promise<'applied' | 'already_settled' | 'changed'> {
    if (!isVerifiedStrategyReceipt(evidence))
      throw new Error('Strategy settlement requires newly verified chain evidence.')
    return this.sql.begin(async (tx) => {
      const [attempt] = await tx<
        AttemptRow[]
      >`SELECT * FROM execution_attempts WHERE id = ${attemptId} FOR UPDATE`
      const [operation] = await tx<
        OperationRow[]
      >`SELECT * FROM strategy_operations WHERE attempt_id = ${attemptId} FOR UPDATE`
      if (!attempt || !operation) return 'changed' as const
      const [watch] = await tx<
        WatchRow[]
      >`SELECT * FROM strategy_watches WHERE id = ${operation.watch_id} FOR UPDATE`
      if (
        !watch ||
        attempt.purpose !== 'strategy' ||
        attempt.chain_id !== 56 ||
        attempt.transaction_hash !== evidence.transactionHash ||
        attempt.executor_address !== evidence.executor ||
        watch.vault !== evidence.vault ||
        watch.policy_hash !== evidence.policyHash ||
        watch.manager !== evidence.manager ||
        operation.operation_digest !== evidence.operationDigest ||
        operation.call_data_hash !== evidence.callDataHash ||
        operation.envelope_hash !== evidence.envelopeHash ||
        BigInt(operation.expected_nonce).toString() !== evidence.expectedNonce
      )
        return 'changed' as const
      const terminal = evidence.status === 'landed' ? 'LANDED' : 'REVERTED'
      if (attempt.state === terminal && operation.state === terminal)
        return 'already_settled' as const
      if (!pending.includes(attempt.state) || operation.state !== 'PENDING')
        return 'changed' as const
      if (
        evidence.status === 'landed' &&
        (!evidence.outcome ||
          evidence.nextNonce !== (BigInt(operation.expected_nonce) + 1n).toString())
      )
        throw new Error('Missing verified strategy transition.')
      const receiptBlock = BigInt(evidence.blockNumber)
      const previousBlock = watch.snapshot_block === null ? null : BigInt(watch.snapshot_block)
      if (previousBlock === receiptBlock && watch.snapshot_hash !== lower(evidence.blockHash))
        return 'changed' as const
      // Receipt evidence sets a lower bound, but cannot replace newer complete state
      // with an older transaction-local nonce or block identity.
      const advanceBlock = previousBlock === null || receiptBlock > previousBlock
      const watermarkBlock = advanceBlock ? evidence.blockNumber : watch.snapshot_block
      const watermarkHash = advanceBlock ? lower(evidence.blockHash) : watch.snapshot_hash
      const receiptNonce = BigInt(evidence.nextNonce ?? operation.expected_nonce)
      const checkpointNonce =
        receiptNonce > BigInt(watch.checkpoint_nonce)
          ? receiptNonce.toString()
          : watch.checkpoint_nonce
      await tx`UPDATE strategy_operations SET state = ${terminal}, verified_receipt = ${tx.json(json(evidence))},
        completed_at = now() WHERE attempt_id = ${attemptId}`
      // This is an operation checkpoint, NOT a fresh complete on-chain snapshot.
      // Recovery never restarts a stopped watch. Reverts require fresh state and review.
      await tx`UPDATE strategy_watches SET
        checkpoint_nonce = ${checkpointNonce}::numeric,
        checkpoint = ${tx.json(json(evidence))},
        snapshot_block = ${watermarkBlock}::numeric, snapshot_hash = ${watermarkHash},
        chain_snapshot = NULL, snapshot_timestamp = NULL,
        status = CASE WHEN status = 'CLOSED' THEN status WHEN ${terminal} = 'REVERTED' THEN 'NEEDS_REVIEW' ELSE status END,
        revision = revision + 1, updated_at = now() WHERE id = ${watch.id}`
      await tx`UPDATE execution_attempts SET state = ${terminal}, updated_at = now() WHERE id = ${attemptId}`
      const detail =
        terminal === 'LANDED'
          ? evidence.outcome?.kind === 'grid' && !evidence.outcome.filled
            ? `Grid observed. No trade made. ${evidence.transactionHash}`
            : `Strategy operation confirmed. ${evidence.transactionHash}`
          : `Strategy transaction reverted. Review required before restarting. ${evidence.transactionHash}`
      await tx`INSERT INTO job_events (job_id, type, detail, at) VALUES (${watch.job_id}, 'status', ${detail}, now())`
      return 'applied' as const
    })
  }
}
