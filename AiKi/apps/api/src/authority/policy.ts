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
  const expiry = constraints.find((c) => c.kind === 'expiry')?.value
  const expiresAt = typeof expiry === 'string' ? expiry : undefined
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
  if (policy.expiresAt && Date.parse(action.at) >= Date.parse(policy.expiresAt))
    return { allow: false, rule: 'expiry', reason: 'Authorization has expired.' }
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
