import type { Category } from '@aiki/contracts'

/**
 * What an agent's OWN registration says it does.
 *
 * This is a declaration AiKi read, never a capability AiKi probed. Nothing in
 * the evidence store measures what an agent is able to do: `agent.capability_probe`
 * records only whether an endpoint answered and whether it varied by id, and
 * `services[].name` names a transport as often as a skill. So this classifies
 * text an operator wrote about themselves, and the published shape has to be
 * read that way.
 *
 * Rules are ordered and the first match wins, so the specific categories are
 * tested before the general ones: an agent that rebalances an LP range to chase
 * yield is a rebalancer, and calling it a yield optimiser because the word
 * appears later in its description would be worse than calling it neither.
 *
 * One classifier, called from both the SQL and the in-memory aggregate. Two
 * copies in two dialects would drift, and the parity test between those
 * aggregates exists precisely because that drift is the risk.
 */
const RULES: { category: Category; when: RegExp }[] = [
  {
    category: 'health_factor',
    when: /health factor|liquidation risk|avoid liquidation|liquidation protection|loan health|collateral ratio|borrow position|lending position/,
  },
  {
    category: 'rebalancing',
    when: /rebalanc|re-balanc|lp range|liquidity range|reposition|range reset|concentrated liquidity/,
  },
  {
    category: 'grid_trading',
    when: /grid trad|grid strateg|grid order|grid bot|\bgrid\b/,
  },
  {
    category: 'yield_optimisation',
    when: /yield|\bapr\b|\bapy\b|supply rate|best rate|highest earning|capital allocation/,
  },
]

/**
 * The text a manifest offers about itself, lowercased and joined.
 *
 * Service names are hyphenated slugs, so the hyphens are spaces here for the
 * same reason they are in the search document: `venus-health-factor-assessment`
 * is otherwise one token that matches nothing.
 */
export function declaredText(manifest: {
  name?: unknown
  description?: unknown
  services?: unknown
}): string {
  const services = Array.isArray(manifest.services)
    ? manifest.services
        .map((s) => (s && typeof s === 'object' ? (s as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === 'string')
        .join(' ')
    : ''
  return [
    typeof manifest.name === 'string' ? manifest.name : '',
    typeof manifest.description === 'string' ? manifest.description : '',
    services,
  ]
    .join(' ')
    .replace(/-/g, ' ')
    .toLowerCase()
}

/**
 * `other` means the agent declared something no rule recognised, which is a
 * measurement and not a gap. An agent that declared NOTHING is not classified
 * here at all: the caller must leave it out rather than file it under `other`,
 * because there is no declaration to have failed to match.
 */
export function classifyDeclared(text: string): Category {
  if (!text.trim()) return 'other'
  for (const rule of RULES) if (rule.when.test(text)) return rule.category
  return 'other'
}
