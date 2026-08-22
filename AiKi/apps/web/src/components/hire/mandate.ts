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
          'This agent’s session module holds lifetime caps only. A renewing cap here is counted by AiKi and reset by AiKi — the chain does not know about it.',
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
