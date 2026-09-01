import type { EnforcementTier } from '@aiki/contracts'

export const TIER_WORD: Record<EnforcementTier, string> = {
  T0: 'On-chain',
  T1: 'A signer',
  T2: 'AiKi only',
  T3: 'After the fact',
}

export const TIER_MEANS: Record<EnforcementTier, string> = {
  T0: 'The chain refuses the transaction. Holds even if AiKi and the agent are both compromised.',
  T1: 'A signer we do not control refuses. Holds against a compromised agent only.',
  T2: 'AiKi refuses to relay. Holds against a buggy agent, not against a compromised AiKi.',
  T3: 'Nothing stops it. You find out afterwards.',
}

const ORDER: EnforcementTier[] = ['T0', 'T1', 'T2', 'T3']

/** The headline number is the WEAKEST link, never the average or the best. */
export const weakest = (tiers: EnforcementTier[]): EnforcementTier =>
  tiers.reduce((w, t) => (ORDER.indexOf(t) > ORDER.indexOf(w) ? t : w), 'T0')

export type ApprovalMode = 'automatic' | 'notify' | 'approve_above_threshold' | 'approve_every'

export interface MandateInput {
  capCents: number
  perActionCents: number
  days: number
  /**
   * Whether a person has to say yes before the agent acts, and above what.
   *
   * Sent with the mandate, which it was not for the life of the product: this
   * screen offered four modes, none of them reached the API, and the agent
   * acted regardless of which was chosen.
   */
  approval: { mode: ApprovalMode; thresholdCents: number }
  /**
   * What the agent may move. Empty means it cannot move anything.
   *
   * `decimals` is not decoration. A cap is sent to the API as a whole number of
   * an asset's base units and compiled straight into on-chain caveat terms, and
   * this screen thinks in dollars, so something has to do the conversion.
   */
  spends: { asset: `0x${string}`; symbol: string; decimals: number }[]
}

/**
 * A dollar amount as base units of the asset the cap applies to.
 *
 * Verified wrong on production before this existed. A mandate labelled "Never
 * spend more than $250.00 in total" was sent with the value `25000`, which as
 * base units of an eighteen-decimal asset is 0.000000000000025 of a token: a
 * factor of 10^16 out. Compiled into a caveat, the chain would have refused
 * every transaction the agent tried, and the screen said $250 the whole time.
 *
 * The settlement asset is dollar-pegged, so a dollar is a token and this is a
 * unit conversion rather than a price. There is no oracle here and this must
 * not become one: an asset that is not pegged cannot have a dollar cap
 * expressed this way, and saying so is better than guessing a rate.
 */
function baseUnits(cents: number, decimals: number): string {
  return ((BigInt(Math.round(cents)) * 10n ** BigInt(decimals)) / 100n).toString()
}

/**
 * The ERC-20 calls that move money out of an account.
 *
 * A cap has to name the functions it applies to, because the enforcers read the
 * amount out of the call and refuse when they cannot find one. `approve` is here
 * deliberately and is the one people forget: an approval hands a spender the
 * right to take the tokens later, so a cap that governed only `transfer` would
 * leave the obvious way around it open.
 */
const MOVES_MONEY = [
  '0xa9059cbb', // transfer(address,uint256)
  '0x095ea7b3', // approve(address,uint256)
  '0x23b872dd', // transferFrom(address,address,uint256)
]

/**
 * The constraints a hire actually sends, built in one place.
 *
 * The builder previews what the chain will hold and the hire then creates it,
 * and those two must be the same mandate. Building them separately would mean
 * previewing one thing and signing another, which is a worse lie than showing
 * no preview at all.
 *
 * The scope is what lets a cap be held by a chain rather than by us. The
 * enforcers find the amount in a call by matching its contract and function, and
 * refuse the call outright when no match exists, so a cap with nothing in scope
 * is not a cap they can hold. Naming the tokens the agent may move, and the three
 * ERC-20 calls that move them, is what turns the spend limits from something AiKi
 * counts into something the chain refuses to exceed.
 *
 * The scope comes from the agent, never from the person hiring: it is a
 * description of what that agent does, so widening it is not a choice a user
 * should be offered.
 */
export function mandateConstraints(input: MandateInput): {
  kind: string
  label: string
  value: string | string[] | { mode: string; threshold: string }
  tier: EnforcementTier
}[] {
  const expiresAt = new Date(Date.now() + input.days * 86_400_000).toISOString()
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`
  const assets = input.spends.map((s) => s.asset)
  const names = input.spends.map((s) => s.symbol).join(' and ')
  // An empty allowlist reads as "no restriction" to the enforcer, so an agent
  // that moves nothing gets no scope constraints rather than empty ones.
  const scope = assets.length
    ? [
        {
          kind: 'contract_allowlist',
          label: `Can only call ${names}`,
          value: assets,
          tier: 'T2' as EnforcementTier,
        },
        {
          kind: 'selector_allowlist',
          label: 'Can only move tokens, not call anything else',
          value: MOVES_MONEY,
          tier: 'T2' as EnforcementTier,
        },
        {
          kind: 'asset_scope',
          label: `Only ${names}`,
          value: assets,
          tier: 'T2' as EnforcementTier,
        },
      ]
    : []
  // An agent that cannot move anything needs no spend caps, and sending them
  // anyway would put two limits on the mandate that govern nothing. The screen
  // already says it cannot spend; the mandate should agree.
  /*
   * One number, applied to each asset in scope.
   *
   * The API compiles a cap into one caveat per asset with the same figure, and
   * refuses a policy carrying two caveats of the same kind, so there is exactly
   * one cap value and it has to mean something for every asset it covers. With
   * mixed decimals it cannot, so the smallest is taken: that makes the cap
   * smaller than asked for rather than larger, which is the direction a limit
   * should err in when it cannot be exact.
   */
  const decimals = input.spends.length ? Math.min(...input.spends.map((s) => s.decimals)) : 18
  const caps = assets.length
    ? [
        {
          kind: 'session_total_cap',
          label: `Never spend more than ${usd(input.capCents)} in total`,
          value: baseUnits(input.capCents, decimals),
          // Claimed, and overwritten by the API, which decides this against its
          // deployed enforcers. Nothing here may be rendered as a verdict.
          tier: 'T2' as EnforcementTier,
        },
        ...(input.perActionCents > 0
          ? [
              {
                kind: 'per_action_cap',
                label: `Never spend more than ${usd(input.perActionCents)} at once`,
                value: baseUnits(input.perActionCents, decimals),
                tier: 'T2' as EnforcementTier,
              },
            ]
          : []),
      ]
    : []
  /*
   * Always sent, including for "just do it".
   *
   * A mandate that records the choice can be read back and shown, and an absent
   * constraint would be indistinguishable from a mandate made before approvals
   * existed. The API treats automatic and notify as acting immediately, so
   * saying so costs nothing and settles what was chosen.
   */
  const approval = {
    kind: 'approval',
    label:
      input.approval.mode === 'approve_every'
        ? 'Asks you before every action'
        : input.approval.mode === 'approve_above_threshold'
          ? `Asks you before anything over ${usd(input.approval.thresholdCents)}`
          : input.approval.mode === 'notify'
            ? 'Acts, and tells you as it happens'
            : 'Acts inside these limits without asking',
    value: {
      mode: input.approval.mode,
      threshold: baseUnits(input.approval.thresholdCents, decimals),
    },
    // Claimed and overwritten by the API, like every other tier here. It will
    // come back T2: no contract can wait for a person.
    tier: 'T2' as EnforcementTier,
  }
  return [
    ...scope,
    ...caps,
    approval,
    {
      kind: 'expiry',
      label: `Expires ${expiresAt.slice(0, 10)}`,
      value: expiresAt,
      tier: 'T2',
    },
  ]
}
