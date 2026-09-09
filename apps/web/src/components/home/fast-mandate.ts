import type { ExecutionNetwork } from '@aiki/contracts/guardian'
import { formatUnits } from 'viem'
import { api, type MandateContinuation } from '@/lib/api'
import { readInjectedAccount, signMandate } from '@/lib/wallet'
import { walletSession } from '@/lib/wallet-session'
import {
  assertExecutionNetwork,
  assertGuardianEnforcement,
  assertMandateAccount,
  assertPreparedDelegation,
  assertWalletReady,
  loadExecutionNetwork,
  type PreparedDelegation,
  signPreparedDelegation,
} from '../hire/guardian-activation'

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const address = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value)

/** History contains data, not authority. Revalidate selected fields before offering a control. */
export function parseMandateContinuation(value: unknown): MandateContinuation | null {
  const action = object(value)
  if (
    action?.kind !== 'sign_mandate' ||
    typeof action.authorizationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      action.authorizationId,
    ) ||
    (action.chainId !== 56 && action.chainId !== 97) ||
    !address(action.account) ||
    !address(action.manager)
  )
    return null
  return {
    kind: 'sign_mandate',
    authorizationId: action.authorizationId.toLowerCase(),
    chainId: action.chainId,
    account: action.account.toLowerCase(),
    manager: action.manager.toLowerCase(),
  }
}

export function mandateContinuations(steps: unknown): MandateContinuation[] {
  const actions = new Map<string, MandateContinuation>()
  for (const value of Array.isArray(steps) ? steps : []) {
    const step = object(value)
    const action =
      step?.ok === true && step.tool === 'create_mandate'
        ? parseMandateContinuation(step.action)
        : null
    if (action) actions.set(action.authorizationId, action)
  }
  return [...actions.values()]
}

export interface FastMandateDependencies {
  network: typeof loadExecutionNetwork
  account(): Promise<unknown>
  prepare: typeof api.prepareDelegation
  file: typeof api.fileDelegation
  sign: typeof signPreparedDelegation
  session: typeof walletSession
  readWallet: typeof readInjectedAccount
}
const dependencies: FastMandateDependencies = {
  network: loadExecutionNetwork,
  account: api.account,
  prepare: api.prepareDelegation,
  file: api.fileDelegation,
  sign: signPreparedDelegation,
  session: walletSession,
  readWallet: readInjectedAccount,
}
interface Review {
  perActionUsdt: string
  totalUsdt: string
  expiresAt: string
  network: ExecutionNetwork
}
interface Snapshot {
  phase: 'idle' | 'loading' | 'review' | 'signing' | 'signed' | 'blocked' | 'uncertain'
  review?: Review
  error?: string
}
interface PreparedReview {
  prep: PreparedDelegation
  review: Review
  state: 'review' | 'signed' | 'blocked'
  reason?: string
}
const sameList = (value: unknown, expected: string) =>
  Array.isArray(value) &&
  value.length === 1 &&
  typeof value[0] === 'string' &&
  value[0].toLowerCase() === expected.toLowerCase()

function inspectPreparation(
  prep: PreparedDelegation,
  action: MandateContinuation,
  owner: string,
  network: ExecutionNetwork,
): PreparedReview {
  const auth = prep.authorization
  if (
    !auth ||
    auth.id !== action.authorizationId ||
    auth.owner?.toLowerCase() !== owner.toLowerCase() ||
    !/^[0-9a-f]{64}$/i.test(auth.policyHash) ||
    !Array.isArray(auth.constraints) ||
    auth.constraints.length !== 6
  )
    throw new Error('The saved mandate could not be verified. No signature was requested.')
  const limits = prep.limits
  const caveats = prep.unsigned.caveats
  if (
    !Array.isArray(limits) ||
    limits.length !== 6 ||
    limits.some((limit) => !object(limit) || typeof limit.kind !== 'string') ||
    new Set(limits.map((limit) => limit.kind)).size !== 6 ||
    !Array.isArray(caveats) ||
    caveats.length !== 6 ||
    new Set(caveats.map((caveat) => String(object(caveat)?.enforcer).toLowerCase())).size !== 6
  )
    throw new Error('All six on-chain limits must be verified before this mandate can be signed.')
  assertGuardianEnforcement(
    {
      network: network.network,
      audited: network.audited,
      tier: 'T0',
      limits: limits.map((limit) => ({ ...limit, why: '' })),
    },
    network,
  )
  const constraints = new Map(
    auth.constraints.map((constraint) => [constraint.kind, constraint.value]),
  )
  const units = (kind: string) => {
    const value = constraints.get(kind)
    if (
      typeof value !== 'string' ||
      !/^\d{1,78}$/.test(value) ||
      BigInt(value) <= 0n ||
      BigInt(value) >= 2n ** 256n
    )
      throw new Error('The stored spending limits could not be verified.')
    return BigInt(value)
  }
  const perAction = units('per_action_cap')
  const total = units('session_total_cap')
  const expiry = constraints.get('expiry')
  if (
    constraints.size !== 6 ||
    perAction > total ||
    !sameList(constraints.get('asset_scope'), network.guardian.asset) ||
    !sameList(constraints.get('contract_allowlist'), network.guardian.market) ||
    !sameList(constraints.get('selector_allowlist'), network.guardian.repayBorrowSelector) ||
    typeof expiry !== 'string' ||
    !Number.isFinite(Date.parse(expiry))
  )
    throw new Error('The saved limits do not match the supported Venus repayment scope.')
  const review: Review = {
    perActionUsdt: formatUnits(perAction, network.guardian.decimals),
    totalUsdt: formatUnits(total, network.guardian.decimals),
    expiresAt: new Date(expiry).toISOString(),
    network,
  }
  if (auth.status === 'revoked')
    return {
      prep,
      review,
      state: 'blocked',
      reason: 'This mandate is revoked in AiKi. It cannot be signed here.',
    }
  if (auth.status === 'expired' || Date.parse(expiry) <= Date.now())
    return {
      prep,
      review,
      state: 'blocked',
      reason: 'This mandate has expired. It cannot be signed.',
    }
  if (auth.status !== 'active')
    return {
      prep,
      review,
      state: 'blocked',
      reason: 'This mandate is not active. No signature was requested.',
    }
  if (auth.signedAt !== null || auth.delegator !== null || auth.delegationChainId !== null) {
    if (
      typeof auth.signedAt !== 'string' ||
      !Number.isFinite(Date.parse(auth.signedAt)) ||
      auth.delegator?.toLowerCase() !== action.account ||
      auth.delegationChainId !== action.chainId
    )
      throw new Error(
        'The filed mandate does not match this account and network. Check its status before continuing.',
      )
    return { prep, review, state: 'signed' }
  }
  return { prep, review, state: 'review' }
}

/** There are deliberately no authorization creation, job, watch, funding or model APIs here. */
export class FastMandateController {
  private state: Snapshot = { phase: 'idle' }
  private listeners = new Set<() => void>()
  private generation = 0
  private reviewed: { value: PreparedReview; revision: number } | undefined
  private action: MandateContinuation
  constructor(
    action: MandateContinuation,
    private owner: string,
    private deps: FastMandateDependencies = dependencies,
  ) {
    const checked = parseMandateContinuation(action)
    if (!checked || !address(owner)) throw new Error('Invalid mandate continuation.')
    this.action = checked
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(state: Snapshot) {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  dispose = () => {
    this.generation++
    this.reviewed = undefined
  }
  invalidate = () => {
    this.dispose()
    this.update({
      phase: 'idle',
      error: 'Your wallet changed. Review this mandate again after signing in.',
    })
  }
  private async current(revision: number, generation: number): Promise<PreparedReview> {
    const network = await this.deps.network()
    if (
      network.chainId !== this.action.chainId ||
      network.manager.toLowerCase() !== this.action.manager
    )
      throw new Error('The execution deployment changed. This saved mandate cannot be signed here.')
    await assertWalletReady(this.owner, network, revision, this.deps)
    const account = assertMandateAccount(await this.deps.account(), network, true)
    if (account.address?.toLowerCase() !== this.action.account)
      throw new Error('The mandate account changed. No signature was requested.')
    const prep = await this.deps.prepare(this.action.authorizationId, this.action.account)
    await assertWalletReady(this.owner, network, revision, this.deps)
    if (generation !== this.generation)
      throw new Error('The mandate review was closed. Nothing further was filed.')
    assertPreparedDelegation(prep, network, this.action.account)
    return inspectPreparation(prep, this.action, this.owner, network)
  }
  private present(value: PreparedReview) {
    this.update({
      phase: value.state,
      review: value.review,
      ...(value.reason ? { error: value.reason } : {}),
    })
  }
  async review() {
    if (this.state.phase === 'loading' || this.state.phase === 'signing') return
    const generation = ++this.generation
    const revision = this.deps.session().revision
    this.reviewed = undefined
    this.update({ phase: 'loading' })
    try {
      const value = await this.current(revision, generation)
      if (generation !== this.generation) return
      this.reviewed = { value, revision }
      this.present(value)
    } catch (error) {
      if (generation === this.generation) this.update({ phase: 'idle', error: guidance(error) })
    }
  }
  async sign() {
    if (this.state.phase !== 'review' || !this.reviewed) return
    const { value: reviewed, revision } = this.reviewed
    const generation = this.generation
    let filing = false
    this.update({ phase: 'signing', review: reviewed.review })
    try {
      const fresh = await this.current(revision, generation)
      if (fresh.state !== 'review') {
        this.present(fresh)
        return
      }
      assertExecutionNetwork(reviewed.review.network, fresh.review.network)
      if (JSON.stringify(reviewed.prep) !== JSON.stringify(fresh.prep))
        throw new Error('The prepared mandate changed. Review its current limits before signing.')
      const delegation = await this.deps.sign(
        fresh.prep,
        fresh.review.network,
        this.action.account,
        this.owner,
        {
          network: this.deps.network,
          account: this.deps.account,
          readWallet: this.deps.readWallet,
          session: this.deps.session,
          sign: async (owner, typedData) => {
            await assertWalletReady(this.owner, fresh.review.network, revision, this.deps)
            if (generation !== this.generation)
              throw new Error('The mandate review was closed. No signature was requested.')
            return signMandate(owner, typedData)
          },
        },
      )
      const after = await this.current(revision, generation)
      if (after.state !== 'review') {
        this.present(after)
        return
      }
      assertExecutionNetwork(fresh.review.network, after.review.network)
      if (JSON.stringify(fresh.prep) !== JSON.stringify(after.prep))
        throw new Error(
          'The prepared mandate changed while signing. Nothing was filed. Review it again.',
        )
      filing = true
      const filed = await this.deps.file(this.action.authorizationId, delegation)
      await assertWalletReady(this.owner, fresh.review.network, revision, this.deps)
      if (generation !== this.generation) return
      if (
        filed.id !== this.action.authorizationId ||
        filed.delegator?.toLowerCase() !== this.action.account ||
        filed.delegationChainId !== this.action.chainId ||
        filed.status !== 'active' ||
        typeof filed.signedAt !== 'string' ||
        !Number.isFinite(Date.parse(filed.signedAt))
      )
        throw new Error('The signed mandate could not be confirmed.')
      this.reviewed = undefined
      this.update({ phase: 'signed', review: fresh.review })
    } catch (error) {
      if (generation !== this.generation) return
      this.reviewed = undefined
      this.update({
        phase: filing ? 'uncertain' : 'idle',
        error: filing
          ? 'The signature may already be filed. Check this same mandate before signing again. No job or watch was started.'
          : guidance(error),
      })
    }
  }
}

function guidance(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  // Never render a transport URL, driver dump or arbitrary response payload.
  return message && message.length <= 300 && !/https?:|\n|[{}]/i.test(message)
    ? message
    : 'This mandate could not be verified. No further action was taken. Review it again later.'
}
