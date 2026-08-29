import type { CapPeriod, EnforcementTier } from '@aiki/contracts'
import type { AgentDetail } from '@/lib/detail'

/**
 * What a given agent can actually enforce, read off its passport rather than
 * assumed.
 *
 * This is the whole point of the builder: two agents can offer the same limit
 * and mean completely different things by it. A cap held by
 * ERC20PeriodTransferEnforcer genuinely resets each period on chain. A cap held
 * by SmartSession's spendLimit is lifetime-only — asking it for a monthly cap
 * does not produce a monthly cap, it produces a promise, and the builder has to
 * say so at the moment you choose it rather than in the small print.
 */
export interface Capabilities {
  /** Periods the chain itself can hold. */
  renewingOnChain: boolean
  lifetimeOnChain: boolean
  perActionTier: EnforcementTier
  perActionVerified: boolean
  perActionBy: string
  allowlistTier: EnforcementTier
  allowlistBy: string
  expiryOnChain: boolean
}

export function capabilitiesOf(d: AgentDetail): Capabilities {
  const by = (needle: string) => d.enforcement.find((e) => e.enforcedBy.includes(needle))
  const period = by('ERC20PeriodTransferEnforcer')
  const lifetime = by('spendLimit')
  const allow = by('UniversalActionPolicy')
  const perAction =
    d.enforcement.find((e) => /one action|per action|per-action/i.test(e.label)) ??
    period ??
    lifetime ??
    d.enforcement[0]

  return {
    renewingOnChain: Boolean(period),
    lifetimeOnChain: Boolean(period ?? lifetime),
    perActionTier: perAction?.tier ?? 'T2',
    perActionVerified: perAction?.verified ?? false,
    perActionBy: perAction?.enforcedBy ?? 'aiki:policy-service',
    allowlistTier: allow?.tier ?? 'T2',
    allowlistBy: allow?.enforcedBy ?? 'aiki:policy-service',
    expiryOnChain: Boolean(allow ?? period),
  }
}

export interface TierVerdict {
  tier: EnforcementTier
  verified: boolean
  by: string
  /** Said out loud next to the control, not buried in a footnote. */
  caveat?: string
}

/** Which tier a chosen cap period actually lands on for this agent. */
export function capTier(c: Capabilities, period: CapPeriod): TierVerdict {
  if (period === 'total') {
    return c.lifetimeOnChain
      ? { tier: 'T0', verified: true, by: 'SmartSession:spendLimit' }
      : {
          tier: 'T2',
          verified: true,
          by: 'aiki:policy-service',
          caveat: 'Counted by AiKi before relaying. No contract holds it.',
        }
  }
  if (period === 'per_transaction') {
    return {
      tier: c.perActionTier,
      verified: c.perActionVerified,
      by: c.perActionBy,
      ...(c.perActionTier === 'T0' && c.perActionVerified
        ? {}
        : { caveat: 'Held off-chain. A compromised signer could exceed it.' }),
    }
  }
  return c.renewingOnChain
    ? { tier: 'T0', verified: true, by: 'ERC20PeriodTransferEnforcer' }
    : {
        tier: 'T2',
        verified: true,
        by: 'aiki:policy-service',
        caveat:
          'This agent’s session module holds lifetime caps only. A renewing cap here is counted by AiKi and reset by AiKi. The chain does not know about it.',
      }
}

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

export interface MandateInput {
  capCents: number
  perActionCents: number
  days: number
  /** What the agent may move. Empty means it cannot move anything. */
  spends: { asset: `0x${string}`; symbol: string }[]
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
  value: string | string[]
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
  const caps = assets.length
    ? [
        {
          kind: 'session_total_cap',
          label: `Never spend more than ${usd(input.capCents)} in total`,
          value: String(input.capCents),
          // Claimed, and overwritten by the API, which decides this against its
          // deployed enforcers. Nothing here may be rendered as a verdict.
          tier: 'T2' as EnforcementTier,
        },
        ...(input.perActionCents > 0
          ? [
              {
                kind: 'per_action_cap',
                label: `Never spend more than ${usd(input.perActionCents)} at once`,
                value: String(input.perActionCents),
                tier: 'T2' as EnforcementTier,
              },
            ]
          : []),
      ]
    : []
  return [
    ...scope,
    ...caps,
    {
      kind: 'expiry',
      label: `Expires ${expiresAt.slice(0, 10)}`,
      value: expiresAt,
      tier: 'T2',
    },
  ]
}
