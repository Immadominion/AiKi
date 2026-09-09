import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  ROOT_AUTHORITY,
  type UnsignedDelegation,
} from '@aiki/contracts/delegation'
import {
  type ExecutionNetwork,
  guardianConstraints,
  parseExecutionNetwork,
} from '@aiki/contracts/guardian'
import { keccak256, recoverTypedDataAddress, toHex } from 'viem'
import { api, apiRequest, type Enforcement } from '@/lib/api'
import { readInjectedAccount, signMandate } from '@/lib/wallet'
import { walletSession } from '@/lib/wallet-session'
import { type MandateInput, mandateConstraints } from './mandate'

export async function loadExecutionNetwork(): Promise<ExecutionNetwork> {
  return parseExecutionNetwork(await apiRequest('/v1/execution/network'))
}

export function assertExecutionNetwork(expected: ExecutionNetwork, current: unknown) {
  const verified = parseExecutionNetwork(current)
  if (JSON.stringify(parseExecutionNetwork(expected)) !== JSON.stringify(verified))
    throw new Error('The execution network changed. Refresh and review the limits before signing.')
  return verified
}

const address = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value)

export function assertMandateAccount(value: unknown, network: ExecutionNetwork, required = false) {
  const account = value as { address?: unknown; chainId?: unknown } | null
  if (
    !account ||
    account.chainId !== network.chainId ||
    (!address(account.address) && (required || account.address !== null))
  )
    throw new Error('The mandate account could not be verified on this execution network.')
  return { address: account.address as `0x${string}` | null, chainId: network.chainId }
}

export type PreparedDelegation = Awaited<ReturnType<typeof api.prepareDelegation>>
const signingJson = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  )

/** Pin the signing schema and bind the filed bytes to the exact message shown to the wallet. */
export function assertPreparedDelegation(
  prep: PreparedDelegation,
  network: ExecutionNetwork,
  account: string,
) {
  const domain = prep?.domain as Record<string, unknown> | null
  const unsigned = prep?.unsigned as unknown as UnsignedDelegation | null
  const expectedDomain = delegationDomain(network.chainId, network.manager)
  if (
    !domain ||
    domain.chainId !== expectedDomain.chainId ||
    domain.name !== expectedDomain.name ||
    domain.version !== expectedDomain.version ||
    typeof domain.verifyingContract !== 'string' ||
    domain.verifyingContract.toLowerCase() !== network.manager ||
    Object.keys(domain).length !== Object.keys(expectedDomain).length ||
    prep.primaryType !== 'Delegation' ||
    JSON.stringify(prep.types) !== JSON.stringify(DELEGATION_TYPES) ||
    !unsigned ||
    !address(unsigned.delegate) ||
    !address(unsigned.delegator) ||
    unsigned.delegator.toLowerCase() !== account.toLowerCase() ||
    unsigned.authority !== ROOT_AUTHORITY ||
    !/^\d+$/.test(String(unsigned.salt)) ||
    !/^\d+$/.test(String(unsigned.epoch)) ||
    !Array.isArray(unsigned.caveats) ||
    unsigned.caveats.length === 0 ||
    unsigned.caveats.some(
      (c) => !address(c.enforcer) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(c.terms) || c.args !== '0x',
    ) ||
    signingJson(prep.message) !== signingJson(delegationMessage(unsigned))
  )
    throw new Error(
      'The signing request does not match the verified network, manager and mandate account.',
    )
}

export interface GuardianSigningDependencies {
  network(): Promise<ExecutionNetwork>
  account(): Promise<unknown>
  readWallet: typeof readInjectedAccount
  sign: typeof signMandate
  session: typeof walletSession
}

const signingDependencies: GuardianSigningDependencies = {
  network: loadExecutionNetwork,
  account: () => api.account(),
  readWallet: readInjectedAccount,
  sign: signMandate,
  session: walletSession,
}

export async function assertWalletReady(
  owner: string,
  network: ExecutionNetwork,
  revision: number,
  deps: Pick<GuardianSigningDependencies, 'session' | 'readWallet'> = signingDependencies,
) {
  const active = await deps.readWallet()
  const session = deps.session()
  if (
    !address(owner) ||
    session.revision !== revision ||
    session.address !== owner.toLowerCase() ||
    !active ||
    active.address.toLowerCase() !== owner.toLowerCase() ||
    active.chainId !== network.chainId
  )
    throw new Error(
      `Connect and sign in with the same wallet on BNB ${network.network} (${network.chainId}) before continuing.`,
    )
}

/** No file/create/watch side effects: Fast can reuse this for an existing authorization. */
export async function signPreparedDelegation(
  prep: PreparedDelegation,
  network: ExecutionNetwork,
  account: string,
  owner: string,
  dependencies: Partial<GuardianSigningDependencies> = {},
) {
  const deps = { ...signingDependencies, ...dependencies }
  const revision = deps.session().revision
  const ensureCurrent = async () => {
    await assertWalletReady(owner, network, revision, deps)
    assertExecutionNetwork(network, await deps.network())
    if (
      assertMandateAccount(await deps.account(), network, true).address?.toLowerCase() !==
      account.toLowerCase()
    )
      throw new Error('The mandate account changed. Refresh before signing.')
    await assertWalletReady(owner, network, revision, deps)
  }
  // Clone so the exact validated bytes remain stable while the wallet prompt is open.
  const prepared = JSON.parse(JSON.stringify(prep)) as PreparedDelegation
  assertPreparedDelegation(prepared, network, account)
  await ensureCurrent()
  const signature = await deps.sign(owner, {
    domain: prepared.domain,
    types: prepared.types,
    primaryType: prepared.primaryType,
    message: prepared.message,
  })
  if (signature === 'declined')
    throw new Error('The mandate signature was declined. No job was started.')
  await ensureCurrent()
  const recovered = await recoverTypedDataAddress({
    domain: prepared.domain,
    types: prepared.types,
    primaryType: prepared.primaryType,
    message: prepared.message,
    signature,
  } as Parameters<typeof recoverTypedDataAddress>[0]).catch(() => null)
  if (recovered?.toLowerCase() !== owner.toLowerCase())
    throw new Error('The signature did not come from your connected wallet. No job was started.')
  return { ...prepared.unsigned, signature }
}

const REQUIRED_ONCHAIN: Record<string, string> = {
  expiry: 'ExpiryEnforcer',
  contract_allowlist: 'AllowedTargetsEnforcer',
  selector_allowlist: 'AllowedSelectorsEnforcer',
  asset_scope: 'AssetScopeEnforcer',
  per_action_cap: 'PerActionCapEnforcer',
  session_total_cap: 'SessionTotalCapEnforcer',
}
export function assertGuardianEnforcement(enforcement: Enforcement, network: ExecutionNetwork) {
  if (
    enforcement.network !== network.network ||
    Object.entries(REQUIRED_ONCHAIN).some(
      ([kind, enforcer]) =>
        !enforcement.limits.some(
          (limit) => limit.kind === kind && limit.tier === 'T0' && limit.enforcedBy === enforcer,
        ),
    )
  )
    throw new Error(
      'The required on-chain repayment limits are unavailable. No mandate was activated.',
    )
}

export function guardianMandateConstraints(input: MandateInput, network: ExecutionNetwork) {
  if (
    !Number.isSafeInteger(input.capCents) ||
    !Number.isSafeInteger(input.perActionCents) ||
    input.perActionCents > input.capCents ||
    !Number.isSafeInteger(input.approval.thresholdCents) ||
    input.approval.thresholdCents < 0
  )
    throw new Error('Choose valid USDT limits before continuing.')
  guardianConstraints({
    chainId: network.chainId,
    totalUsdt: input.capCents / 100,
    perActionUsdt: input.perActionCents / 100,
    expiresInDays: input.days,
  })
  const { guardian } = network
  return mandateConstraints({
    ...input,
    spends: [{ asset: guardian.asset, symbol: 'USDT', decimals: guardian.decimals }],
    callScope: {
      contracts: [guardian.market],
      selectors: [guardian.repayBorrowSelector],
      label: `the Venus USDT market on BNB ${network.network}`,
    },
  })
}

export interface GuardianActivationDependencies extends GuardianSigningDependencies {
  preview: typeof api.previewMandate
  createAccount: typeof api.createAccount
  authorize: typeof api.authorize
  prepare: typeof api.prepareDelegation
  file: typeof api.fileDelegation
  createJob: typeof api.createJob
  attempts: GuardianAttemptStore
}

export interface GuardianAttempt {
  fingerprint: string
  createdAt: number
  authorizationId: string | null
  idempotencyKey: string
}
export interface GuardianAttemptStore {
  read(key: string): GuardianAttempt | null
  write(key: string, attempt: GuardianAttempt): void
  clear(key: string): void
}
export function createGuardianAttemptStore(
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): GuardianAttemptStore {
  const heldAttempts = new Map<string, GuardianAttempt>()
  return {
    read(key) {
      const held = heldAttempts.get(key)
      if (held) return held
      let parsed: GuardianAttempt
      try {
        const raw = storage().getItem(key)
        if (!raw) return null
        parsed = JSON.parse(raw) as GuardianAttempt
      } catch {
        throw new Error(
          'Pending setup storage is unavailable. Enable browser storage or review existing mandates before continuing.',
        )
      }
      if (
        !parsed ||
        typeof parsed.fingerprint !== 'string' ||
        !/^0x[0-9a-f]{64}$/.test(parsed.fingerprint) ||
        !Number.isSafeInteger(parsed.createdAt) ||
        parsed.createdAt <= 0 ||
        typeof parsed.idempotencyKey !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(parsed.idempotencyKey) ||
        (parsed.authorizationId !== null &&
          (typeof parsed.authorizationId !== 'string' ||
            !/^[a-zA-Z0-9-]+$/.test(parsed.authorizationId)))
      )
        throw new Error(
          'The pending mandate could not be read. Review existing mandates before creating another.',
        )
      heldAttempts.set(key, parsed)
      return parsed
    },
    write(key, attempt) {
      try {
        storage().setItem(key, JSON.stringify(attempt))
      } catch {
        throw new Error(
          'The setup retry key could not be saved. Enable browser storage before creating a mandate.',
        )
      }
      heldAttempts.set(key, attempt)
    },
    clear(key) {
      heldAttempts.delete(key)
      try {
        storage().removeItem(key)
      } catch {
        /* A stale stored attempt reopens the same idempotent job, not new authority. */
      }
    },
  }
}
const browserAttempts = createGuardianAttemptStore(() => sessionStorage)

function reviewedConstraints(constraints: unknown) {
  if (!Array.isArray(constraints))
    throw new Error('The stored mandate limits could not be verified.')
  return constraints
    .map((constraint: { kind: string; value: unknown }) => ({
      kind: constraint.kind,
      value: constraint.value,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

function assertStoredMandate(
  prep: PreparedDelegation,
  authorizationId: string,
  owner: string,
  constraints: ReturnType<typeof mandateConstraints>,
  network: ExecutionNetwork,
  account: string,
) {
  const held = prep.authorization
  if (
    !held ||
    held.id !== authorizationId ||
    held.owner?.toLowerCase() !== owner.toLowerCase() ||
    held.status !== 'active' ||
    !/^[a-f0-9]{64}$/i.test(held.policyHash) ||
    signingJson(reviewedConstraints(held.constraints)) !==
      signingJson(reviewedConstraints(constraints))
  )
    throw new Error(
      'The stored mandate does not match the limits you reviewed, or is no longer active. No new authority was created.',
    )
  const expiry = constraints.find((c) => c.kind === 'expiry')
  if (!expiry || Date.parse(String(expiry.value)) <= Date.now())
    throw new Error('This pending mandate has expired. No job was started.')
  if (
    held.signedAt !== null &&
    (!Number.isFinite(Date.parse(held.signedAt)) ||
      held.delegator?.toLowerCase() !== account.toLowerCase() ||
      held.delegationChainId !== network.chainId)
  )
    throw new Error('The existing signature does not cover this mandate account and network.')
  return held
}

const activeSetups = new Set<string>()

/** Creates and signs authority only. WatchPanel starts repayment after the API's readiness checks. */
export async function activateGuardianMandate(
  input: MandateInput,
  expected: ExecutionNetwork,
  owner: string,
  dependencies: Partial<GuardianActivationDependencies> = {},
) {
  const key = `aiki.guardian-activation:${owner.toLowerCase()}:${expected.chainId}:${expected.manager.toLowerCase()}`
  if (activeSetups.has(key))
    throw new Error('This wallet already has a repayment setup in progress.')
  activeSetups.add(key)
  try {
    return await activateGuardianAttempt(input, expected, owner, key, dependencies)
  } finally {
    activeSetups.delete(key)
  }
}

async function activateGuardianAttempt(
  input: MandateInput,
  expected: ExecutionNetwork,
  owner: string,
  key: string,
  dependencies: Partial<GuardianActivationDependencies>,
) {
  const deps: GuardianActivationDependencies = {
    ...signingDependencies,
    preview: api.previewMandate,
    createAccount: api.createAccount,
    authorize: api.authorize,
    prepare: api.prepareDelegation,
    file: api.fileDelegation,
    createJob: api.createJob,
    attempts: browserAttempts,
    ...dependencies,
  }
  const revision = deps.session().revision
  const network = assertExecutionNetwork(expected, await deps.network())
  const fingerprint = keccak256(
    toHex(
      signingJson({
        network,
        capCents: input.capCents,
        perActionCents: input.perActionCents,
        days: input.days,
        approval: input.approval,
      }),
    ),
  )
  let attempt = deps.attempts.read(key)
  if (attempt && attempt.fingerprint !== fingerprint)
    throw new Error(
      'Finish the pending repayment setup with the same limits before creating a different mandate.',
    )
  const createdAt = attempt?.createdAt ?? Date.now()
  const expiresAt = new Date(createdAt + input.days * 86_400_000).toISOString()
  if (Date.parse(expiresAt) <= Date.now())
    throw new Error('This pending mandate has expired. No job was started.')
  const constraints = guardianMandateConstraints(input, network).map((constraint) =>
    constraint.kind === 'expiry'
      ? { ...constraint, value: expiresAt, label: `Expires ${expiresAt.slice(0, 10)}` }
      : constraint,
  )
  await assertWalletReady(owner, network, revision, deps)
  assertGuardianEnforcement(await deps.preview(constraints), network)
  let account = assertMandateAccount(await deps.account(), network)
  assertExecutionNetwork(network, await deps.network())
  await assertWalletReady(owner, network, revision, deps)
  attempt ??= { fingerprint, createdAt, authorizationId: null, idempotencyKey: crypto.randomUUID() }
  // Persist and verify storage before any deployment or authority mutation, including retries.
  deps.attempts.write(key, attempt)
  if (!account.address) account = assertMandateAccount(await deps.createAccount(), network, true)
  const accountAddress = account.address as `0x${string}`
  assertExecutionNetwork(network, await deps.network())
  await assertWalletReady(owner, network, revision, deps)
  if (!attempt?.authorizationId) {
    // Persist uncertainty before creating authority. Losing its acknowledgement must not create another.
    const authorization = await deps.authorize(constraints, attempt.idempotencyKey)
    if (
      !authorization.id ||
      !/^[a-zA-Z0-9-]+$/.test(authorization.id) ||
      authorization.owner?.toLowerCase() !== owner.toLowerCase()
    )
      throw new Error('The mandate owner could not be verified. No signature was requested.')
    attempt = { ...attempt, authorizationId: authorization.id }
    deps.attempts.write(key, attempt)
  }
  const authorizationId = attempt.authorizationId as string
  let prep = await deps.prepare(authorizationId, accountAddress)
  const held = assertStoredMandate(
    prep,
    authorizationId,
    owner,
    constraints,
    network,
    accountAddress,
  )
  if (!held.signedAt) {
    const delegation = await signPreparedDelegation(prep, network, accountAddress, owner, deps)
    await assertWalletReady(owner, network, revision, deps)
    const filed = await deps.file(authorizationId, delegation)
    if (
      filed.id !== authorizationId ||
      filed.status !== 'active' ||
      !filed.signedAt ||
      !Number.isFinite(Date.parse(filed.signedAt)) ||
      filed.delegationChainId !== network.chainId ||
      filed.delegator?.toLowerCase() !== accountAddress.toLowerCase()
    )
      throw new Error(
        'The signed mandate could not be confirmed. Retry the same setup to check it; no new authority will be created.',
      )
  }
  // Re-read status after filing, including when resuming an uncertain acknowledged signature.
  prep = await deps.prepare(authorizationId, accountAddress)
  const signed = assertStoredMandate(
    prep,
    authorizationId,
    owner,
    constraints,
    network,
    accountAddress,
  )
  if (!signed.signedAt)
    throw new Error('The mandate signature is not confirmed yet. Retry the same setup.')
  assertExecutionNetwork(network, await deps.network())
  await assertWalletReady(owner, network, revision, deps)
  const job = await deps.createJob(authorizationId, `hire:${authorizationId}`)
  deps.attempts.clear(key)
  return { authorization: { id: authorizationId }, job }
}
