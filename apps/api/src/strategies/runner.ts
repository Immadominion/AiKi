import { randomUUID } from 'node:crypto'
import { type Hex, keccak256, stringToHex } from 'viem'
import {
  type StrategyDeploymentConfig,
  strategyDeploymentConfigDigest,
  strategyDeploymentSnapshotTarget,
  strategyDeploymentYieldReadConfig,
} from './deployment-config.js'
import {
  type StrategyDeploymentReader,
  verifyStrategyDeploymentConfiguration,
} from './deployment-verification.js'
import { decodeStoredStrategyDelegation } from './envelope.js'
import type { StrategyExecutionResult } from './execution.js'
import { nonzeroAddress } from './operation.js'
import type { StrategyReceiptReader } from './receipt.js'
import { recoverStrategyOperation } from './recovery.js'
import { planStrategyPass, type StrategyPassPlan, type StrategyPlanReader } from './runner-plan.js'
import { parseStrategyRunnerPolicy } from './runner-policy.js'
import type { PostgresStrategyRunnerStore, StrategyRunnerClaim } from './runner-store.js'
import { verifyStrategyMandate } from './setup-readiness.js'
import { verifyStrategySnapshot } from './snapshot.js'
import type { PostgresStrategyStore } from './store.js'

export type StrategyRunnerReader = StrategyPlanReader &
  StrategyDeploymentReader &
  StrategyReceiptReader & {
    getBalance(input: { address: Hex; blockNumber: bigint }): Promise<bigint>
  }
type Scheduler = Pick<
  PostgresStrategyRunnerStore,
  'heartbeat' | 'claimDue' | 'listPendingAttemptIds' | 'savePlannerState' | 'finishPass'
>
type Store = Pick<
  PostgresStrategyStore,
  'syncSnapshot' | 'getPendingAttempt' | 'settle' | 'requireReview'
>
export interface StrategyRunnerInput {
  scheduler: Scheduler
  store: Store
  reader: StrategyRunnerReader
  config: StrategyDeploymentConfig | null
  executor?: Hex
  execute?: (input: {
    claim: StrategyRunnerClaim
    expectedRevision: string
    plan: Extract<StrategyPassPlan, { act: true }>
  }) => Promise<StrategyExecutionResult>
  limit?: number
  now?: () => number
}
export interface StrategySweepReport {
  ready: boolean
  recovered: number
  looked: number
  acted: number
  waiting: number
  stopped: number
}
const absentConfigHash = keccak256(stringToHex('aiki.strategy-runner.unconfigured.v1'))

/** One bounded pass. Recovery has no sender; only a newly verified, explicitly ACTIVE watch may execute. */
export async function runStrategySweep(input: StrategyRunnerInput): Promise<StrategySweepReport> {
  const { scheduler, store, reader } = input,
    now = input.now ?? (() => Math.floor(Date.now() / 1000)),
    instanceId = randomUUID()
  const report: StrategySweepReport = {
    ready: false,
    recovered: 0,
    looked: 0,
    acted: 0,
    waiting: 0,
    stopped: 0,
  }
  const limit = input.limit ?? 5
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('Strategy sweep size must be between one and twenty.')
  // Even an unconfigured or unfunded worker may reconcile a previously submitted exact hash.
  for (const attemptId of await scheduler.listPendingAttemptIds(20)) {
    const result = await recoverStrategyOperation({ store, reader, attemptId })
    if (result.status === 'landed' || result.status === 'reverted') report.recovered++
  }
  let configurationHash = absentConfigHash
  const heartbeat = (ready: boolean) =>
    scheduler.heartbeat({
      instanceId,
      configurationHash,
      ...(nonzeroAddress(input.executor) ? { executor: input.executor } : {}),
      ready,
      reason: ready
        ? 'Strategy runner is ready.'
        : 'Strategy runner is unavailable. No new operation will be submitted.',
    })
  if (!input.config) {
    await heartbeat(false)
    return report
  }
  const config = input.config
  try {
    configurationHash = strategyDeploymentConfigDigest(config)
  } catch {
    await heartbeat(false)
    return report
  }
  const executor = input.executor
  if (!executor || !nonzeroAddress(executor) || !input.execute) {
    await heartbeat(false)
    return report
  }
  try {
    const proof = await verifyStrategyDeploymentConfiguration(config, reader, {
      nowSeconds: BigInt(now()),
    })
    const balance = await reader.getBalance({ address: executor, blockNumber: proof.block.number })
    if (typeof balance !== 'bigint' || balance < 100_000_000_000_000n) {
      await heartbeat(false)
      return report
    }
  } catch {
    await heartbeat(false)
    return report
  }
  report.ready = true
  await heartbeat(true)
  // Claim just one at a time so queued work never ages past its planning lease.
  for (let index = 0; index < limit; index++) {
    const [claim] = await scheduler.claimDue(1, 90)
    if (!claim) break
    report.looked++
    let intervalSeconds = claim.binding.kind === 'grid' ? 30 : 60
    const finish = async (code: string, reason: string, stop = false) => {
      await scheduler.finishPass({
        watchId: claim.watchId,
        leaseId: claim.leaseId,
        code,
        reason,
        intervalSeconds,
        stop,
      })
      if (stop) report.stopped++
      else report.waiting++
    }
    try {
      if (
        claim.executor !== executor.toLowerCase() ||
        claim.manager !== config.manager.address ||
        claim.bindingEnforcer !== config.bindingEnforcer.address ||
        claim.authorizationStatus !== 'active' ||
        !claim.authorizationExpiresAt ||
        Date.parse(claim.authorizationExpiresAt) <= now() * 1000 ||
        !['AUTHORIZED', 'RUNNING'].includes(claim.jobStatus)
      ) {
        await finish(
          'AUTHORITY_CHANGED',
          'Automation is paused. Review the account and its permission.',
          true,
        )
        continue
      }
      const proof = await verifyStrategySnapshot(
        strategyDeploymentSnapshotTarget(config, claim.binding),
        reader,
      )
      if (proof.status !== 'verified') {
        await finish('STATE_UNAVAILABLE', 'Waiting for verified vault state.')
        continue
      }
      const snapshot = proof.snapshot
      // Proxy implementation pins and protocols are rechecked at this exact custody block.
      await verifyStrategyDeploymentConfiguration(config, reader, { block: snapshot.block })
      if (
        snapshot.owner !== claim.owner ||
        snapshot.manager !== claim.manager ||
        snapshot.expiresAt <= BigInt(now())
      ) {
        await finish(
          'AUTHORITY_CHANGED',
          'Automation is paused. Review the account and its permission.',
          true,
        )
        continue
      }
      const mandate = await verifyStrategyMandate({
        snapshot,
        delegation: claim.delegation,
        owner: claim.owner,
        executor,
        reader,
        nowSeconds: now(),
      })
      if (!mandate.ready) {
        await finish('AUTHORITY_UNAVAILABLE', mandate.reason, !mandate.retryable)
        continue
      }
      const synced = await store.syncSnapshot({
        watchId: claim.watchId,
        expectedRevision: claim.revision,
        snapshot,
      })
      if (synced.status !== 'applied' || !synced.active) {
        await finish('STATE_CHANGED', 'Automation is paused or its state changed.')
        continue
      }
      let policy: ReturnType<typeof parseStrategyRunnerPolicy>
      try {
        policy = parseStrategyRunnerPolicy(claim.policy, snapshot, claim.gasLimitWei, {
          poolRuntimeCodeHash: config.protocols.pancakePool,
        })
      } catch {
        await finish(
          'POLICY_MISMATCH',
          'The saved strategy policy needs review before restarting.',
          true,
        )
        continue
      }
      intervalSeconds = policy.intervalSeconds
      const delegation = decodeStoredStrategyDelegation(claim.delegation)
      const plan = await planStrategyPass({
        snapshot,
        policy,
        delegation,
        executor,
        reader,
        plannerState: claim.plannerState,
        gasLimitWei: claim.gasLimitWei,
        now,
        ...(claim.binding.kind === 'yield'
          ? { yieldConfig: strategyDeploymentYieldReadConfig(config, claim.binding) }
          : {}),
      })
      // CAS binds both the fresh snapshot revision and the still-owned lease. No lease, no send.
      const revision = await scheduler.savePlannerState({
        watchId: claim.watchId,
        leaseId: claim.leaseId,
        expectedRevision: synced.revision,
        state: plan.nextState ?? claim.plannerState,
      })
      if (revision === null) {
        await finish('STATE_CHANGED', 'Strategy state changed. No new operation was submitted.')
        continue
      }
      if (!plan.act) {
        await finish(plan.code, plan.reason.slice(0, 240))
        continue
      }
      if (
        plan.gasBudgetWei > claim.gasLimitWei ||
        (await reader.getBalance({ address: executor, blockNumber: snapshot.block.number })) <
          plan.gasBudgetWei
      ) {
        await finish('GAS_UNAVAILABLE', 'Execution is waiting for gas within the approved limit.')
        continue
      }
      const result = await input.execute({ claim, expectedRevision: revision, plan })
      const landed = result.status === 'landed'
      await scheduler.finishPass({
        watchId: claim.watchId,
        leaseId: claim.leaseId,
        intervalSeconds,
        code: landed
          ? 'CONFIRMED'
          : result.status === 'blocked'
            ? 'STATE_CHANGED'
            : 'EXECUTION_REVIEW',
        reason: landed
          ? 'Operation confirmed on BSC.'
          : result.status === 'blocked'
            ? 'Strategy state changed. No new operation was submitted.'
            : 'Execution needs review. No replacement transaction will be sent.',
        stop:
          result.status === 'refused' ||
          result.status === 'reverted' ||
          result.status === 'needs_review',
      })
      if (landed) report.acted++
      else if (result.status === 'blocked') report.waiting++
      else report.stopped++
    } catch {
      // Never expose raw RPC errors, credentials, signed permissions or SQL to user activity.
      await finish(
        'READ_UNAVAILABLE',
        'Waiting for a complete verified read. No new operation is being retried.',
      )
    } finally {
      await heartbeat(true)
    }
  }
  await heartbeat(true)
  return report
}
