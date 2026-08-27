import { createHash, randomUUID } from 'node:crypto'
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
  if (!constraints.length) throw new Error('At least one constraint is required.')
  // The chain refuses a delegation carrying two caveats of the same kind, because a shared
  // spend counter would be incremented twice by two identical stateful caveats. Off chain
  // duplicates are merely applied in turn, which quietly means their intersection. Accepting a
  // mandate here that could never be redeemed there is the worst of both: the user is told
  // their limits are set, and every action fails.
  const kinds = new Set<string>()
  for (const c of constraints) {
    if (kinds.has(c.kind))
      throw new Error(
        `Duplicate ${c.kind} constraint. A mandate carries at most one of each kind, because the chain cannot represent two.`,
      )
    kinds.add(c.kind)
  }

  const expiryConstraint = constraints.find((c) => c.kind === 'expiry')
  // An expiry we cannot read must not compile into a mandate that simply has no
  // expiry. That failure is silent and total: the constraint still renders in
  // the UI as a limit while nothing anywhere enforces it.
  if (expiryConstraint && typeof expiryConstraint.value !== 'string')
    throw new Error('Expiry must be an ISO-8601 string.')
  const expiresAt = expiryConstraint?.value as string | undefined
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error('Expiry must be ISO-8601.')
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
