import type { ProjectedPassport } from '@aiki/contracts'
import { paletteFor } from '@/components/home/live-shards'
import { AGENT_BG, AGENT_BY_KEY, type AgentKey } from './agents'
import { type Counts, DETAILS } from './detail'

/**
 * One shape the comparison renders, whoever supplied it.
 *
 * The compare page holds the best writing in the product: it says "we cannot
 * tell these apart yet", shows the overlapping ranges, and works out what would
 * settle it. All of that ran on the example set, so it was reasoning carefully
 * about numbers nobody measured. This is the seam that lets the same reasoning
 * run on real passports.
 */
export interface CompareSubject {
  key: string
  name: string
  initial: string
  bg: string
  checks: Counts
  components: {
    liveness: Counts
    executionReliability: Counts | null
    outcomeQuality: Counts | null
    reputation: Counts | null
    safety: Counts | null
  }
  registeredAt: string
  /** Null where the agent publishes none, which on this registry is nearly all of them. */
  price: string | null
  /**
   * Whether any limit on this agent rests on something softer than the chain.
   * Unknown for a third-party agent, because AiKi has not read its enforcement.
   */
  softEnforcement: boolean | null
}

const asCounts = (c: { successes: number; trials: number } | null | undefined): Counts | null =>
  c ? [c.successes, c.trials] : null

/** A real agent, from what AiKi has actually observed of it. */
export function subjectFromPassport(passport: ProjectedPassport): CompareSubject {
  const display = (passport.name ?? `Agent ${passport.agentId}`).replace(/^AiKi\s+/i, '')
  return {
    key: passport.agentId,
    name: display,
    initial: (display.charAt(0) || '?').toUpperCase(),
    bg: paletteFor(passport.agentId).bg,
    checks: asCounts(passport.checks) ?? [0, 0],
    components: {
      liveness: asCounts(passport.components?.liveness) ?? [0, 0],
      // Null, not [0,0]. A component we have never measured is not a component
      // scoring zero, and the cell renders "never observed" rather than a number.
      executionReliability: asCounts(passport.components?.executionReliability),
      outcomeQuality: asCounts(passport.components?.outcomeQuality),
      reputation: asCounts(passport.components?.reputation),
      safety: asCounts(passport.components?.safety),
    },
    registeredAt: passport.identity?.createdAt ?? passport.lastProbeAt ?? new Date(0).toISOString(),
    price: null,
    softEnforcement: null,
  }
}

/** One of the six examples, kept so the existing links still resolve. */
export function subjectFromFixture(key: AgentKey): CompareSubject {
  const detail = DETAILS[key]
  const meta = AGENT_BY_KEY[key]
  // Only ever called with one of the six example keys.
  if (!detail || !meta) throw new Error(`No example agent called ${key}.`)
  return {
    key,
    name: meta.name,
    initial: meta.initial,
    bg: AGENT_BG[key] ?? '#171715',
    checks: detail.checks,
    components: detail.components,
    registeredAt: detail.registeredAt,
    price: meta.price,
    softEnforcement: detail.enforcement.some((e) => e.tier !== 'T0' || !e.verified),
  }
}

/** ERC-8004 token ids are numeric; the example keys are words. */
export const isAgentId = (key: string) => /^\d+$/.test(key)
