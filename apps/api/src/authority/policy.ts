import { createHash, randomUUID } from 'node:crypto'
import { ClientError } from '../http/errors.js'
export type EnforcementTier = 'T0' | 'T1' | 'T2' | 'T3'
export interface Constraint {
  kind:
    | 'contract_allowlist'
    | 'selector_allowlist'
    | 'asset_scope'
    | 'per_action_cap'
    | 'session_total_cap'
    | 'expiry'
    | 'condition'
    | 'approval'
  value: unknown
  tier: EnforcementTier
  label: string
}
export interface Action {
  target: string
  selector: string
  asset: string
  amount: bigint
  at: string
}
export interface CompiledPolicy {
  id: string
  hash: string
  constraints: Constraint[]
  weakestTier: EnforcementTier
  expiresAt?: string
}
const rank: Record<EnforcementTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 }
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 0)
export function compilePolicy(constraints: Constraint[]): CompiledPolicy {
  if (!constraints.length) throw new ClientError('At least one constraint is required.')
  // The chain refuses a delegation carrying two caveats of the same kind, because a shared
  // spend counter would be incremented twice by two identical stateful caveats. Off chain
  // duplicates are merely applied in turn, which quietly means their intersection. Accepting a
  // mandate here that could never be redeemed there is the worst of both: the user is told
  // their limits are set, and every action fails.
  const kinds = new Set<string>()
  for (const c of constraints) {
    if (kinds.has(c.kind))
      throw new ClientError(
        `Duplicate ${c.kind} constraint. A mandate carries at most one of each kind, because the chain cannot represent two.`,
      )
    kinds.add(c.kind)
  }

  const expiryConstraint = constraints.find((c) => c.kind === 'expiry')
  // An expiry we cannot read must not compile into a mandate that simply has no
  // expiry. That failure is silent and total: the constraint still renders in
  // the UI as a limit while nothing anywhere enforces it.
  if (expiryConstraint && typeof expiryConstraint.value !== 'string')
    throw new ClientError('Expiry must be an ISO-8601 string.')
  const expiresAt = expiryConstraint?.value as string | undefined
  if (expiresAt && Number.isNaN(Date.parse(expiresAt)))
    throw new ClientError('Expiry must be ISO-8601.')
  return {
    id: randomUUID(),
    hash: createHash('sha256').update(canonical(constraints)).digest('hex'),
    constraints,
    weakestTier: constraints.reduce<EnforcementTier>(
      (weakest, c) => (rank[c.tier] > rank[weakest] ? c.tier : weakest),
      'T0',
    ),
    ...(expiresAt ? { expiresAt } : {}),
  }
}
export function evaluatePolicy(
  policy: CompiledPolicy,
  action: Action,
  spent: bigint,
): { allow: boolean; rule: string; reason: string } {
  if (policy.expiresAt) {
    const at = Date.parse(action.at)
    // Fail closed on an unreadable timestamp. Comparing NaN yields false, so the
    // original check let an action with a garbage `at` slip past an expired
    // mandate entirely rather than being refused by it.
    if (Number.isNaN(at))
      return { allow: false, rule: 'expiry', reason: 'Action timestamp is not a valid time.' }
    if (at >= Date.parse(policy.expiresAt))
      return { allow: false, rule: 'expiry', reason: 'Authorization has expired.' }
  }
  for (const c of policy.constraints) {
    const values = Array.isArray(c.value) ? c.value.map(String).map((v) => v.toLowerCase()) : []
    if (c.kind === 'contract_allowlist' && !values.includes(action.target.toLowerCase()))
      return { allow: false, rule: c.kind, reason: 'Target is not allowlisted.' }
    if (c.kind === 'selector_allowlist' && !values.includes(action.selector.toLowerCase()))
      return { allow: false, rule: c.kind, reason: 'Function selector is not allowlisted.' }
    if (c.kind === 'asset_scope' && !values.includes(action.asset.toLowerCase()))
      return { allow: false, rule: c.kind, reason: 'Asset is outside mandate scope.' }
    if (c.kind === 'per_action_cap' && action.amount > BigInt(String(c.value)))
      return { allow: false, rule: c.kind, reason: 'Action exceeds per-action cap.' }
    if (c.kind === 'session_total_cap' && spent + action.amount > BigInt(String(c.value)))
      return { allow: false, rule: c.kind, reason: 'Action exceeds lifetime session cap.' }
  }
  return { allow: true, rule: 'policy', reason: 'Action conforms to compiled constraints.' }
}

/**
 * Whether a mandate permits buying something, and for how much.
 *
 * Hiring an agent moves the buyer's money, and until this existed the payment
 * path did not consult the mandate at all: a revoked authorization still
 * funded, an expired one still funded, and what a hire cost counted against no
 * cap. The whole authority system, which is what AiKi is for, was bypassed by
 * the one route that spends.
 *
 * Not every constraint applies. `contract_allowlist` and `selector_allowlist`
 * describe calls an agent may make on chain, and paying for the agent is not
 * one of them: refusing a hire because the mandate names a lending market would
 * be enforcing a rule against something it was never written about.
 * `asset_scope` is the same shape of mistake in the other direction, since the
 * marketplace settles in one asset regardless of what the agent then trades.
 *
 * What does apply is everything that means "no more money": revoked, expired,
 * too big for one action, or past the total this mandate was ever allowed to
 * spend. Those are refusals about the money, and money is what this is.
 */
/**
 * Whether somebody has to say yes before this action happens.
 *
 * Separate from `evaluatePolicy` because it is not a verdict on the action. A
 * denial means the mandate forbids this; an approval requirement means the
 * mandate permits it once a person agrees, which needs a record and a second
 * visit rather than an answer here.
 *
 * `automatic` and `notify` both act immediately. The difference between them is
 * what gets written down, not whether the action happens, and pretending
 * otherwise would make "tell me each time" a gate it was never described as.
 */
export type ApprovalMode = 'automatic' | 'notify' | 'approve_above_threshold' | 'approve_every'

export interface ApprovalRule {
  mode: ApprovalMode
  /** Base units, for `approve_above_threshold`. Anything at or under goes through. */
  threshold: bigint
}

/** The approval rule a mandate carries, or none, in which case it acts. */
export function approvalRule(policy: CompiledPolicy): ApprovalRule | null {
  for (const c of policy.constraints) {
    if (c.kind !== 'approval') continue
    const value = c.value as { mode?: string; threshold?: string } | string
    const mode = (typeof value === 'string' ? value : value?.mode) as ApprovalMode | undefined
    if (!mode) continue
    let threshold = 0n
    try {
      threshold = typeof value === 'string' ? 0n : BigInt(value?.threshold ?? '0')
    } catch {
      /*
       * A threshold nobody can read is treated as zero, which asks about
       * everything. Failing open here would mean an unreadable number silently
       * turned "ask me over an amount" into "never ask me".
       */
      threshold = 0n
    }
    return { mode, threshold }
  }
  return null
}

/** True when this action may not happen until somebody has agreed to it. */
export function needsApproval(policy: CompiledPolicy, amount: bigint): boolean {
  const rule = approvalRule(policy)
  if (!rule) return false
  if (rule.mode === 'approve_every') return true
  if (rule.mode === 'approve_above_threshold') return amount > rule.threshold
  return false
}

export function evaluatePurchase(
  policy: CompiledPolicy,
  purchase: { amount: bigint; at: string; asset: string },
  spent: bigint,
): { allow: boolean; rule: string; reason: string } {
  /*
   * The cap has to be denominated in the thing being spent.
   *
   * A mandate's caps are a number of base units of the asset it scopes. The
   * marketplace settles in one asset regardless of what the agent then trades,
   * so a mandate scoped to something else has caps that say nothing about
   * buying here: comparing them would be comparing two currencies, and there is
   * no oracle in this system to convert between them. The nearest real example
   * is a mandate Fast mode builds for a lending agent, capped in a six-decimal
   * testnet USDT, against a marketplace that settles in an eighteen-decimal
   * asset. Those numbers differ by 10^12 before anybody has spent anything.
   *
   * Refused rather than waved through. An unpinned cap is not a permissive cap,
   * it is an absent one, and this is the route that spends money.
   */
  const scopes = policy.constraints.filter((c) => c.kind === 'asset_scope')
  const inScope = scopes.some((c) =>
    (Array.isArray(c.value) ? c.value : [c.value])
      .map((v) => String(v).toLowerCase())
      .includes(purchase.asset.toLowerCase()),
  )
  if (!inScope)
    return {
      allow: false,
      rule: 'asset_scope',
      reason: scopes.length
        ? 'This mandate is scoped to a different asset from the one AiKi settles in, so its limits cannot govern a purchase here.'
        : 'This mandate names no asset, so there is no limit that governs spending here.',
    }
  if (policy.expiresAt) {
    const at = Date.parse(purchase.at)
    // Fail closed on an unreadable timestamp, on the same reasoning as above: a
    // NaN comparison is false, so a garbage time would slip past an expired
    // mandate rather than being refused by it.
    if (Number.isNaN(at))
      return { allow: false, rule: 'expiry', reason: 'Purchase timestamp is not a valid time.' }
    if (at >= Date.parse(policy.expiresAt))
      return { allow: false, rule: 'expiry', reason: 'Authorization has expired.' }
  }
  for (const c of policy.constraints) {
    if (c.kind === 'per_action_cap' && purchase.amount > BigInt(String(c.value)))
      return { allow: false, rule: c.kind, reason: 'This hire exceeds the per-action cap.' }
    if (c.kind === 'session_total_cap' && spent + purchase.amount > BigInt(String(c.value)))
      return { allow: false, rule: c.kind, reason: 'This hire exceeds the lifetime session cap.' }
  }
  return { allow: true, rule: 'policy', reason: 'The hire is inside the mandate.' }
}
