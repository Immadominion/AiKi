/**
 * Turning what a person typed into something Postgres can rank agents by.
 *
 * Two rules govern everything here.
 *
 * The first is that the query is attacker input. Every term is reduced to
 * `[a-z0-9]+` before it goes anywhere near `to_tsquery`, which cannot parse
 * hostile syntax it never receives. Nothing is interpolated that has not been
 * through `sanitise`.
 *
 * The second is that expansion may only ADD. A user's own words are always in
 * the query, so an expansion can change what ranks first but can never make a
 * matching agent disappear. That keeps the failure mode "ranked oddly" rather
 * than "silently unfindable", which is the failure this whole area is being
 * repaired for.
 */

/**
 * Words that carry no signal about what an agent does. Dropping them stops a
 * query being dominated by its own filler: "my" and "me" appear in nothing, but
 * "on" and "from" would match nothing while still costing a term.
 */
const STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'best',
  'but',
  'by',
  'can',
  'do',
  'for',
  'from',
  'get',
  'getting',
  'give',
  'help',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'need',
  'of',
  'on',
  'or',
  'our',
  'please',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'up',
  'us',
  'want',
  'was',
  'we',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
])

/**
 * Vocabulary bridges, from how people ask to how agents describe themselves.
 *
 * Each entry exists because a real query failed without it, and the reason is
 * recorded rather than assumed. These are additions to the user's own terms,
 * never replacements.
 */
const EXPANSIONS: { when: RegExp; add: string[]; why: string }[] = [
  {
    /*
     * The `english` dictionary stems both "liquidation" and "liquidity" to
     * "liquid", so a borrower asking to avoid liquidation matches every
     * liquidity-provision agent equally. Measured before this existed: "protect
     * my loan from liquidation" ranked an LP rebalancer above the Venus health
     * factor guardian. The added terms appear in lending agents and not in LP
     * agents, which is what separates them again.
     */
    when: /^(liquidat\w*|loan|loans|borrow\w*|debt|repay\w*|underwater|margin)$/,
    add: ['health', 'factor', 'lending', 'collateral', 'venus'],
    why: 'english stems liquidation and liquidity alike',
  },
  {
    // "Safe" and "protect" are how risk is asked about and never how it is described.
    when: /^(safe|safety|protect\w*|guard\w*|watch|monitor\w*|alert\w*)$/,
    add: ['health', 'factor', 'risk', 'position'],
    why: 'risk is asked about in words no manifest uses',
  },
  {
    // LP is universal in the question and never spelled out in the answer.
    when: /^(lp|pool|pools|position|positions|range|ranges)$/,
    add: ['liquidity', 'rebalance'],
    why: 'lp is an abbreviation manifests expand',
  },
  {
    when: /^(earn|earning|apr|apy|interest|returns?)$/,
    add: ['yield', 'rates', 'supply'],
    why: 'return is asked about as earnings and described as yield',
  },
  {
    when: /^(swap|swaps|trade|trades|trading|bot|bots)$/,
    add: ['grid', 'orders'],
    why: 'automated trading on BSC is overwhelmingly grid strategies',
  },
]

/** Only what `to_tsquery` can never misread. */
function sanitise(term: string): string | null {
  const cleaned = term.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (cleaned.length < 2 || cleaned.length > 40) return null
  return cleaned
}

export interface SearchQuery {
  /** An OR-combined tsquery, safe to interpolate. Null when nothing usable was typed. */
  tsquery: string | null
  /** The user's own terms, after sanitising. */
  terms: string[]
  /** Terms this module added, and why. Returned so the API can show its working. */
  expandedWith: { term: string; why: string }[]
}

/**
 * At most this many terms reach the database. A query is a phrase, not a
 * payload, and an unbounded term count is an unbounded amount of ranking work
 * on an unauthenticated route.
 */
const MAX_TERMS = 12

export function buildSearchQuery(raw: string): SearchQuery {
  const terms: string[] = []
  for (const word of raw.split(/\s+/)) {
    const cleaned = sanitise(word)
    if (!cleaned || STOP.has(cleaned) || terms.includes(cleaned)) continue
    terms.push(cleaned)
    if (terms.length >= MAX_TERMS) break
  }

  const expandedWith: { term: string; why: string }[] = []
  const seen = new Set(terms)
  for (const term of terms) {
    for (const rule of EXPANSIONS) {
      if (!rule.when.test(term)) continue
      for (const addition of rule.add) {
        if (seen.has(addition)) continue
        seen.add(addition)
        expandedWith.push({ term: addition, why: rule.why })
      }
    }
  }

  const all = [...terms, ...expandedWith.map((e) => e.term)]
  return {
    tsquery: all.length ? all.join(' | ') : null,
    terms,
    expandedWith,
  }
}
