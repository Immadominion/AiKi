import { randomUUID } from 'node:crypto'
import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  type SignedDelegation,
} from '@aiki/contracts'
import type {
  StrategyAgentMap,
  StrategyAuthorizationPreparation,
  StrategyAuthorizationReview,
  StrategyPublicConfig,
  StrategySetupView,
  StrategyWalletActionRequest,
} from '@aiki/contracts/strategies'
import { type Hex, hashTypedData } from 'viem'
import { type Constraint, compilePolicy } from '../authority/policy.js'
import { ClientError } from '../http/errors.js'
import {
  finalizeStrategyDeployment,
  prepareStrategyDeployment,
  readStrategySetupSnapshot,
} from './deployment.js'
import {
  type StrategyDeploymentConfig,
  strategyDeploymentConfigDigest,
} from './deployment-config.js'
import { canonicalizeStrategySetupInput } from './deployment-policy.js'
import {
  type StrategyDeploymentReader,
  verifyStrategyDeploymentConfiguration,
} from './deployment-verification.js'
import { encodeStrategyBindingTerms } from './grant.js'
import { nonzeroAddress, nonzeroHash } from './operation.js'
import { recoverStrategyOperation } from './recovery.js'
import { createStrategyRunnerPolicy } from './runner-policy.js'
import {
  prepareStrategyWalletAction,
  type StrategySetupActionReader,
  verifyStrategyWalletReceipt,
} from './setup-actions.js'
import {
  readStrategyEpoch,
  STRATEGY_EXPIRY_ENFORCER,
  strategyUnsignedDelegation,
  verifyStrategyMandate,
} from './setup-readiness.js'
import {
  type PostgresStrategySetupStore,
  type StrategySetupRow,
  setupConflict,
  setupDigest,
  setupJSON,
} from './setup-store.js'
import type { VerifiedStrategySnapshot } from './snapshot.js'
import type { PostgresStrategyStore } from './store.js'

export type StrategySetupReader = StrategyDeploymentReader & StrategySetupActionReader
export interface StrategySetupServiceConfig {
  store: PostgresStrategySetupStore
  strategies: PostgresStrategyStore
  deployments: StrategyDeploymentConfig | null
  executor?: Hex
  reader?: StrategySetupReader
  agents?: StrategyAgentMap
  now?: () => number
}
const unavailable = () =>
  new ClientError(
    'Strategy execution is not available until its reviewed deployments and read-only services are verified.',
    { statusCode: 503, code: 'STRATEGIES_UNAVAILABLE' },
  )
const funded = (snapshot: VerifiedStrategySnapshot) => {
  const s = snapshot.state
  return s.kind === 'yield'
    ? s.managedIdle > 0n || s.managedVenusShares > 0n || s.managedAaveScaled > 0n
    : s.kind === 'grid'
      ? s.allocated0 > 0n || s.allocated1 > 0n
      : s.enrolled &&
        s.currentTokenId > 0n &&
        s.positionLiquidity > 0n &&
        s.position?.owner === snapshot.binding.vault
}
const strictBody = (value: unknown, fields: string[]) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== fields.sort().join(',')
  )
    throw new ClientError('This strategy request contains unsupported or missing fields.')
  return value as Record<string, unknown>
}

/** Owner setup orchestrates reviewed data and read-only proofs. It never receives a signing key. */
export class StrategySetupService {
  constructor(private readonly config: StrategySetupServiceConfig) {}
  private now() {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000)
  }
  private runtime() {
    const { deployments, executor, reader } = this.config
    if (!deployments || !nonzeroAddress(executor) || !reader) throw unavailable()
    return {
      deployments,
      executor: executor.toLowerCase() as Hex,
      reader,
      digest: strategyDeploymentConfigDigest(deployments),
    }
  }
  async publicConfig(): Promise<StrategyPublicConfig> {
    const agents = this.config.agents ? { agents: this.config.agents } : {}
    try {
      const r = this.runtime()
      await verifyStrategyDeploymentConfiguration(r.deployments, r.reader, {
        nowSeconds: BigInt(this.now()),
      })
      const scheduler = await this.config.strategies.schedulerStatus(r.digest)
      return {
        available: true,
        chainId: 56,
        configurationHash: r.digest,
        manager: r.deployments.manager.address,
        executor: r.executor,
        bindingEnforcer: r.deployments.bindingEnforcer.address,
        expiryEnforcer: STRATEGY_EXPIRY_ENFORCER.address,
        kinds: ['yield', 'grid', 'lp'],
        factories: r.deployments.factories,
        schedulerReady: scheduler.ready,
        ...agents,
      }
    } catch {
      return {
        available: false,
        chainId: 56,
        reason:
          'Reviewed strategy factories are not available on this deployment. Reports do not execute trades.',
        ...agents,
      }
    }
  }
  private async snapshot(row: StrategySetupRow) {
    const r = this.runtime()
    const result = await readStrategySetupSnapshot({
      config: r.deployments,
      prepared: row.prepared,
      reader: r.reader,
      nowSeconds: BigInt(this.now()),
    })
    if (
      result.status !== 'verified' ||
      result.snapshot.owner !== row.owner ||
      BigInt(this.now()) < result.snapshot.block.timestamp ||
      BigInt(this.now()) - result.snapshot.block.timestamp > 30n
    )
      throw setupConflict(
        'The current owner, immutable vault, or finalized setup state could not be verified.',
      )
    if (row.binding && setupDigest(row.binding) !== setupDigest(result.snapshot.binding))
      throw setupConflict()
    return result.snapshot
  }
  async prepare(owner: Hex, body: unknown, key: string): Promise<StrategySetupView> {
    const b = strictBody(body, ['input', 'gasLimitWei'])
    let canonical: ReturnType<typeof canonicalizeStrategySetupInput>
    try {
      canonical = canonicalizeStrategySetupInput(b.input)
    } catch {
      throw new ClientError(
        'Use exact bounded strategy policy fields and raw-unit integer amounts.',
      )
    }
    if (BigInt(canonical.common.expiresAt) > 8_640_000_000_000n)
      throw new ClientError(
        'The strategy expiry must be representable by the authorization service.',
      )
    if (
      typeof b.gasLimitWei !== 'string' ||
      !/^[1-9][0-9]{0,15}$/.test(b.gasLimitWei) ||
      BigInt(b.gasLimitWei) > 10n ** 15n
    )
      throw new ClientError('Choose a positive execution gas ceiling up to 0.001 BNB, in raw wei.')
    const digest = setupDigest({ input: canonical, gasLimitWei: b.gasLimitWei }),
      prior = await this.config.store.byKey(owner, key)
    if (prior) {
      if (prior.request_digest !== digest)
        throw setupConflict('This retry key belongs to different reviewed limits.')
      if (
        !prior.binding &&
        !prior.prepared.alreadyDeployed &&
        !(await this.config.store.actions(prior.id, owner)).length
      )
        await this.config.store.prepareAction(
          prior.id,
          owner,
          setupDigest({ kind: 'deploy', request: prior.prepared.requestDigest }),
          {
            kind: 'deploy',
            transaction: prior.prepared.unsignedTransaction,
            review: {
              summary:
                'Deploy this exact immutable, paused strategy vault. This does not fund or start it.',
              recipient: prior.prepared.predictedVault,
            },
          },
        )
      if (!prior.binding && prior.prepared.alreadyDeployed) {
        const snapshot = await this.snapshot(prior)
        await this.config.store.transaction(prior.id, owner, async (tx, row) => {
          if (!row.binding)
            await tx`UPDATE strategy_setups SET binding=${tx.json(setupJSON(snapshot.binding))},revision=revision+1,updated_at=now() WHERE id=${prior.id}`
        })
        return this.get(owner, prior.id)
      }
      return this.view(prior, true)
    }
    const r = this.runtime()
    if (owner.toLowerCase() === r.executor)
      throw new ClientError('The strategy owner must not be the executor.')
    const prepared = await prepareStrategyDeployment({
      config: r.deployments,
      owner,
      input: canonical,
      reader: r.reader,
      nowSeconds: BigInt(this.now()),
    })
    if (prepared.status !== 'prepared') throw setupConflict(prepared.reason)
    const row = await this.config.store.create({
      owner,
      key,
      digest,
      prepared: prepared.prepared,
      gasLimitWei: BigInt(b.gasLimitWei),
    })
    if (prepared.prepared.alreadyDeployed) {
      const snapshot = await this.snapshot(row)
      await this.config.store.transaction(row.id, owner, async (tx, current) => {
        if (current.binding && setupDigest(current.binding) !== setupDigest(snapshot.binding))
          throw setupConflict()
        if (!current.binding)
          await tx`UPDATE strategy_setups SET binding=${tx.json(setupJSON(snapshot.binding))},revision=revision+1,updated_at=now() WHERE id=${row.id}`
      })
    } else
      await this.config.store.prepareAction(
        row.id,
        owner,
        setupDigest({ kind: 'deploy', request: row.prepared.requestDigest }),
        {
          kind: 'deploy',
          transaction: row.prepared.unsignedTransaction,
          review: {
            summary:
              'Deploy this exact immutable, paused strategy vault. This does not fund or start it.',
            recipient: row.prepared.predictedVault,
          },
        },
      )
    return this.get(owner, row.id)
  }
  async get(owner: Hex, id: string) {
    return this.view(await this.config.store.get(id, owner), true)
  }
  async list(owner: Hex): Promise<{ setups: StrategySetupView[] }> {
    return {
      setups: await Promise.all(
        (await this.config.store.list(owner)).map((row) => this.view(row, false)),
      ),
    }
  }
  private async readiness(row: StrategySetupRow) {
    const reasons: string[] = []
    let schedulerReady = false,
      snapshot: VerifiedStrategySnapshot | undefined
    try {
      const r = this.runtime(),
        scheduler = await this.config.strategies.schedulerStatus(r.digest)
      schedulerReady = scheduler.ready
      if (!schedulerReady) reasons.push('The strategy scheduler is not ready.')
      if (!row.binding) {
        reasons.push('Deploy and verify the immutable vault first.')
        return { ready: false, reasons, schedulerReady }
      }
      snapshot = await this.snapshot(row)
      if (row.authority_review) {
        const planner = createStrategyRunnerPolicy(snapshot, BigInt(row.gas_limit_wei), {
          poolRuntimeCodeHash: r.deployments.protocols.pancakePool,
        })
        if (
          setupDigest(row.authority_review.plannerPolicy) !== setupDigest(setupJSON(planner)) ||
          row.authority_review.gasLimitWei !== String(row.gas_limit_wei) ||
          setupDigest(row.authority_review.input) !== setupDigest(row.prepared.input) ||
          setupDigest(row.authority_review.binding) !== setupDigest(snapshot.binding) ||
          row.authority_review.executor !== r.executor ||
          row.authority_review.manager !== snapshot.manager
        )
          reasons.push('The stored signature review no longer matches the reviewed service policy.')
      }
      if (!funded(snapshot)) reasons.push('Explicitly fund or enroll the owner’s position first.')
      if (snapshot.paused)
        reasons.push('Explicitly resume the vault in the owner wallet before starting automation.')
      if (snapshot.expiresAt <= BigInt(this.now()))
        reasons.push('The immutable strategy authority has expired.')
      const native = await r.reader.getBalance({
        address: r.executor,
        blockNumber: snapshot.block.number,
      })
      if (typeof native !== 'bigint' || native < BigInt(row.gas_limit_wei))
        reasons.push('The execution account does not have the configured gas reserve.')
      const authority = await this.config.store.authority(row.id, row.owner)
      if (
        authority?.status !== 'active' ||
        !authority.expiresAt ||
        authority.expiresAt.getTime() <= this.now() * 1000
      )
        reasons.push('Review and sign the exact active strategy mandate first.')
      else {
        const verified = await verifyStrategyMandate({
          snapshot,
          delegation: authority.delegation,
          owner: row.owner,
          executor: r.executor,
          reader: r.reader,
          nowSeconds: this.now(),
        })
        if (!verified.ready) reasons.push(verified.reason)
      }
      if ((await this.config.store.pendingAttempts(row.id, row.owner)).length)
        reasons.push('Reconcile the unresolved strategy transaction first.')
      if (
        (await this.config.store.actions(row.id, row.owner)).some((action) =>
          ['PREPARED', 'SUBMITTED', 'NEEDS_REVIEW'].includes(action.status),
        )
      )
        reasons.push('Resolve the pending owner wallet request first.')
    } catch {
      reasons.push('Current deployment, owner, or chain readiness could not be verified.')
    }
    return {
      ready: reasons.length === 0,
      reasons,
      schedulerReady,
      ...(snapshot ? { snapshot } : {}),
    }
  }
  private async view(row: StrategySetupRow, live: boolean): Promise<StrategySetupView> {
    const watch = row.watch_id
      ? await this.config.strategies.getWatchForOwner(row.watch_id, row.owner)
      : null
    const status: StrategySetupView['status'] =
      watch?.status === 'ACTIVE'
        ? 'ACTIVE'
        : watch?.status === 'NEEDS_REVIEW' || watch?.status === 'CLOSED'
          ? 'NEEDS_REVIEW'
          : watch?.status === 'PAUSED'
            ? 'PAUSED'
            : row.authorization_id
              ? 'SIGNED'
              : row.binding
                ? 'DEPLOYED'
                : 'DRAFT'
    const readiness = live
      ? await this.readiness(row)
      : {
          ready: false,
          reasons: ['Open this setup for fresh chain and scheduler readiness.'],
          schedulerReady: false,
        }
    return {
      id: row.id,
      owner: row.owner,
      chainId: 56,
      kind: row.prepared.kind,
      input: row.prepared.input,
      gasLimitWei: String(row.gas_limit_wei),
      prepared: row.prepared,
      binding: row.binding,
      status,
      revision: String(row.revision),
      actions: await this.config.store.actions(row.id, row.owner),
      ...(watch
        ? {
            watch: {
              status: watch.status,
              nextRunAt: watch.nextRunAt,
              lastDecision:
                watch.reason && watch.lastRunAt
                  ? { code: watch.code, reason: watch.reason, at: watch.lastRunAt }
                  : null,
              lastTransactionHash: watch.lastTransactionHash,
            },
          }
        : {}),
      authorization:
        row.authorization_id && row.job_id && row.watch_id && row.signed_at && row.authority_review
          ? {
              id: row.authorization_id,
              jobId: row.job_id,
              watchId: row.watch_id,
              signedAt: row.signed_at.toISOString(),
              review: row.authority_review,
              ...(row.unsigned_authority ? { unsigned: row.unsigned_authority } : {}),
              ...(row.authority_digest ? { digest: row.authority_digest } : {}),
            }
          : null,
      readiness: {
        ready: readiness.ready,
        reasons: readiness.reasons,
        schedulerReady: readiness.schedulerReady,
      },
    }
  }
  async prepareAction(
    owner: Hex,
    id: string,
    body: unknown,
    key: string,
  ): Promise<StrategySetupView> {
    if (!/^[\x21-\x7e]{1,160}$/.test(key))
      throw new ClientError(
        'A bounded Idempotency-Key is required for each reviewed wallet intent.',
      )
    const row = await this.config.store.get(id, owner),
      r = this.runtime(),
      snapshot = await this.snapshot(row)
    const action = await prepareStrategyWalletAction({
      snapshot,
      owner,
      request: body as StrategyWalletActionRequest,
      reader: r.reader,
      poolRuntimeCodeHash: r.deployments.protocols.pancakePool,
    })
    await this.config.store.prepareAction(
      id,
      owner,
      setupDigest({ key, request: body, kind: action.kind, transaction: action.transaction }),
      action,
      { key, digest: setupDigest(body) },
    )
    return this.get(owner, id)
  }
  async submitAction(
    owner: Hex,
    id: string,
    actionId: string,
    body: unknown,
  ): Promise<StrategySetupView> {
    const b = strictBody(body, ['transactionHash'])
    if (!nonzeroHash(b.transactionHash))
      throw new ClientError('Provide the exact transaction hash returned by the owner wallet.')
    await this.config.store.submitAction(id, owner, actionId, b.transactionHash)
    return this.get(owner, id)
  }
  async finalizeAction(owner: Hex, id: string, actionId: string): Promise<StrategySetupView> {
    const row = await this.config.store.get(id, owner),
      action = await this.config.store.action(id, owner, actionId)
    if (action.status === 'FINALIZED' || action.status === 'REVERTED') return this.get(owner, id)
    if (!action.transactionHash)
      throw setupConflict('Record the exact owner wallet transaction hash before recovery.')
    const r = this.runtime(),
      receipt = await verifyStrategyWalletReceipt(action, r.reader)
    if (!receipt) {
      await this.config.store.finishAction({
        id,
        owner,
        actionId,
        hash: action.transactionHash,
        status: 'NEEDS_REVIEW',
      })
      return this.get(owner, id)
    }
    if (receipt.status === 'REVERTED') {
      await this.config.store.finishAction({
        id,
        owner,
        actionId,
        hash: action.transactionHash,
        ...receipt,
      })
      return this.get(owner, id)
    }
    if (action.kind === 'deploy') {
      const result = await finalizeStrategyDeployment({
        config: r.deployments,
        prepared: row.prepared,
        transactionHash: action.transactionHash,
        reader: r.reader,
        nowSeconds: BigInt(this.now()),
      })
      if (result.status !== 'verified') {
        await this.config.store.finishAction({
          id,
          owner,
          actionId,
          hash: action.transactionHash,
          status: 'NEEDS_REVIEW',
        })
        return this.get(owner, id)
      }
      await this.config.store.finishAction({
        id,
        owner,
        actionId,
        hash: action.transactionHash,
        status: 'FINALIZED',
        block: receipt.block,
        binding: result.binding,
      })
    } else {
      await this.snapshot(row)
      await this.config.store.finishAction({
        id,
        owner,
        actionId,
        hash: action.transactionHash,
        ...receipt,
      })
    }
    return this.get(owner, id)
  }
  async prepareAuthorization(owner: Hex, id: string): Promise<StrategyAuthorizationPreparation> {
    const row = await this.config.store.get(id, owner),
      r = this.runtime(),
      snapshot = await this.snapshot(row)
    if (
      (await this.config.store.actions(id, owner)).some((action) =>
        ['PREPARED', 'SUBMITTED', 'NEEDS_REVIEW'].includes(action.status),
      )
    )
      throw setupConflict('Resolve the existing owner wallet request before reviewing the mandate.')
    if (!funded(snapshot) || snapshot.expiresAt <= BigInt(this.now()))
      throw setupConflict('Fund or enroll this unexpired vault before reviewing its mandate.')
    const planner = createStrategyRunnerPolicy(snapshot, BigInt(row.gas_limit_wei), {
      poolRuntimeCodeHash: r.deployments.protocols.pancakePool,
    })
    const epoch = await readStrategyEpoch(snapshot, r.reader),
      unsigned = strategyUnsignedDelegation({
        snapshot,
        executor: r.executor,
        salt: BigInt(setupDigest({ id, owner, request: row.request_digest })).toString(),
        epoch,
      })
    const review: StrategyAuthorizationReview = {
      owner: row.owner,
      manager: snapshot.manager,
      executor: r.executor,
      binding: { ...snapshot.binding },
      input: row.prepared.input,
      expiresAt: new Date(Number(snapshot.expiresAt) * 1000).toISOString(),
      gasLimitWei: String(row.gas_limit_wei),
      plannerPolicy: setupJSON(planner),
      summary:
        'Authorize only this reviewed immutable strategy vault. The owner funds it separately; activation remains a separate explicit action.',
    }
    const terms = encodeStrategyBindingTerms(snapshot.binding),
      selector = `0x${terms.slice(194, 202)}`
    const constraints: Constraint[] = [
      {
        kind: 'contract_allowlist',
        label: 'Immutable strategy vault',
        value: [snapshot.binding.vault],
        tier: 'T0',
      },
      {
        kind: 'selector_allowlist',
        label: 'Reviewed strategy operation only',
        value: [selector],
        tier: 'T0',
      },
      { kind: 'expiry', label: 'Immutable authority expiry', value: review.expiresAt, tier: 'T0' },
      {
        kind: 'condition',
        label: 'Exact immutable vault policy and reviewed service settings',
        value: review,
        tier: 'T0',
      },
    ]
    const compiled = compilePolicy(constraints),
      digest = hashTypedData({
        domain: delegationDomain(56, snapshot.manager),
        types: DELEGATION_TYPES,
        primaryType: 'Delegation',
        message: delegationMessage(unsigned),
      })
    const stored = await this.config.store.transaction(id, owner, async (tx, current) => {
      if (!current.binding || setupDigest(current.binding) !== setupDigest(snapshot.binding))
        throw setupConflict()
      if (current.unsigned_authority) {
        if (
          setupDigest(current.unsigned_authority) !== setupDigest(unsigned) ||
          setupDigest(current.authority_review) !== setupDigest(review)
        )
          throw setupConflict(
            'The original signature review has changed or was invalidated. Do not sign stale wallet data.',
          )
        return current
      }
      await tx`UPDATE strategy_setups SET unsigned_authority=${tx.json(setupJSON(unsigned))},authority_review=${tx.json(setupJSON(review))},compiled_policy=${tx.json(setupJSON(compiled))},authority_digest=${digest},revision=revision+1,updated_at=now() WHERE id=${id}`
      return {
        ...current,
        unsigned_authority: unsigned,
        authority_review: review,
        compiled_policy: compiled,
        authority_digest: digest,
      }
    })
    if (!stored.unsigned_authority || !stored.authority_review || !stored.authority_digest)
      throw setupConflict()
    return {
      setupId: id,
      review: stored.authority_review,
      unsigned: stored.unsigned_authority,
      domain: { ...delegationDomain(56, snapshot.manager), chainId: 56 },
      types: DELEGATION_TYPES,
      primaryType: 'Delegation',
      message: setupJSON(
        delegationMessage(stored.unsigned_authority),
      ) as StrategyAuthorizationPreparation['message'],
      digest: stored.authority_digest,
    }
  }
  async fileAuthorization(owner: Hex, id: string, body: unknown): Promise<StrategySetupView> {
    const b = strictBody(body, ['signature'])
    if (typeof b.signature !== 'string')
      throw new ClientError('An owner wallet signature is required.')
    const row = await this.config.store.get(id, owner),
      r = this.runtime(),
      snapshot = await this.snapshot(row)
    if (
      !row.unsigned_authority ||
      !row.authority_review ||
      !row.compiled_policy ||
      !row.authority_digest ||
      !row.binding
    )
      throw setupConflict('Review the exact strategy mandate before signing.')
    const currentPlanner = createStrategyRunnerPolicy(snapshot, BigInt(row.gas_limit_wei), {
      poolRuntimeCodeHash: r.deployments.protocols.pancakePool,
    })
    if (
      setupDigest(row.authority_review.plannerPolicy) !== setupDigest(currentPlanner) ||
      row.authority_review.gasLimitWei !== String(row.gas_limit_wei) ||
      setupDigest(row.authority_review.input) !== setupDigest(row.prepared.input) ||
      setupDigest(row.authority_review.binding) !== setupDigest(snapshot.binding)
    )
      throw setupConflict(
        'The stored review no longer matches the current reviewed service settings.',
      )
    const signed: SignedDelegation = { ...row.unsigned_authority, signature: b.signature as Hex }
    const verified = await verifyStrategyMandate({
      snapshot,
      delegation: signed,
      owner,
      executor: r.executor,
      reader: r.reader,
      nowSeconds: this.now(),
    })
    if (!verified.ready || verified.digest !== row.authority_digest)
      throw setupConflict(
        'This signature is not accepted for the current owner and exact reviewed strategy mandate.',
      )
    await this.config.store.transaction(id, owner, async (tx, current) => {
      if (
        current.authority_digest !== verified.digest ||
        setupDigest(current.unsigned_authority) !== setupDigest(row.unsigned_authority)
      )
        throw setupConflict()
      if (current.authorization_id) return
      const authId = randomUUID(),
        jobId = randomUUID(),
        policy = current.compiled_policy
      if (!policy || !current.authority_review) throw setupConflict()
      await tx`INSERT INTO authorizations(id,policy_hash,policy,weakest_tier,status,spent,expires_at,created_at,owner,delegation,delegator,delegation_chain_id,delegation_signed_at)
        VALUES(${authId},${policy.hash},${tx.json(setupJSON(policy))},${policy.weakestTier},'active',0,${current.authority_review.expiresAt},now(),${current.owner},${tx.json(setupJSON(signed))},${snapshot.binding.controller},56,now())`
      await tx`INSERT INTO jobs(id,authorization_id,status,idempotency_key,created_at,updated_at) VALUES(${jobId},${authId},'AUTHORIZED',${`strategy:${id}`},now(),now())`
      const watchId = await this.config.strategies.registerPaused(
        {
          jobId,
          binding: { ...snapshot.binding },
          manager: snapshot.manager,
          executor: r.executor,
          bindingEnforcer: snapshot.bindingEnforcer.address,
          expiresAt: current.authority_review.expiresAt,
          policy: setupJSON(current.authority_review.plannerPolicy),
          gasLimitWei: BigInt(current.gas_limit_wei),
        },
        tx,
      )
      await tx`UPDATE strategy_setups SET authorization_id=${authId},job_id=${jobId},watch_id=${watchId},signed_at=now(),revision=revision+1,updated_at=now() WHERE id=${id}`
      await tx`INSERT INTO job_events(job_id,type,detail,at) VALUES(${jobId},'status','Exact strategy mandate signed. Vault and scheduler activation remain explicit owner actions.',now())`
    })
    return this.get(owner, id)
  }
  async start(owner: Hex, id: string): Promise<StrategySetupView> {
    const row = await this.config.store.get(id, owner)
    if (!row.watch_id) throw setupConflict('Sign the exact strategy mandate before starting.')
    const watch = await this.config.strategies.getWatchForOwner(row.watch_id, owner)
    if (!watch) throw setupConflict()
    const ready = await this.readiness(row)
    if (!ready.ready || !('snapshot' in ready) || !ready.snapshot)
      throw setupConflict(ready.reasons[0] ?? 'Strategy readiness is incomplete.')
    const snapshot = ready.snapshot
    const applied = await this.config.store.transaction(id, owner, async (tx, current) => {
      if (current.watch_id !== watch.id || current.authority_digest !== row.authority_digest)
        throw setupConflict()
      const open =
        await tx`SELECT id FROM strategy_setup_actions WHERE setup_id=${id} AND state IN ('PREPARED','SUBMITTED','NEEDS_REVIEW') LIMIT 1`
      if (open.length)
        throw setupConflict('Resolve the pending owner wallet request before starting.')
      return this.config.strategies.syncSnapshot(
        {
          watchId: watch.id,
          expectedRevision: watch.revision,
          snapshot,
          activateOwner: owner,
        },
        tx,
      )
    })
    if (applied.status !== 'applied' || !applied.active)
      throw setupConflict(
        'Strategy state changed before start. Refresh and explicitly review again.',
      )
    return this.get(owner, id)
  }
  async pause(owner: Hex, id: string): Promise<StrategySetupView> {
    const row = await this.config.store.get(id, owner)
    if (row.watch_id) await this.config.strategies.pause(row.watch_id, owner)
    return this.get(owner, id)
  }
  async recover(owner: Hex, id: string): Promise<StrategySetupView> {
    const row = await this.config.store.get(id, owner),
      r = this.runtime()
    for (const attemptId of await this.config.store.pendingAttempts(id, owner))
      await recoverStrategyOperation({ store: this.config.strategies, attemptId, reader: r.reader })
    for (const action of await this.config.store.actions(row.id, owner))
      if (action.transactionHash && ['SUBMITTED', 'NEEDS_REVIEW'].includes(action.status))
        await this.finalizeAction(owner, id, action.id)
    return this.get(owner, id)
  }
}
