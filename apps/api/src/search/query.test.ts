import { expect, it } from 'vitest'
import { buildSearchQuery } from './query.js'

it('reduces a question to the words that carry signal', () => {
  // "what/is/the/best/for/me" say nothing about any agent, and every term costs
  // ranking work on an unauthenticated route.
  expect(buildSearchQuery('what is the best agent for me').terms).toEqual(['agent'])
  expect(buildSearchQuery('please help me find a venus guardian').terms).toEqual([
    'find',
    'venus',
    'guardian',
  ])
})

it('never lets query syntax reach the parser', () => {
  /*
   * `to_tsquery` throws on malformed input, and a 500 from a search box is an
   * invitation to keep going. Everything is reduced to [a-z0-9]+ first, so the
   * operators are not escaped, they cease to exist.
   */
  for (const hostile of [
    "'; DROP TABLE observations; --",
    'a & b | !c',
    "':*",
    '%%%',
    '____',
    '<script>alert(1)</script>',
  ]) {
    const built = buildSearchQuery(hostile)
    expect(built.tsquery ?? '').not.toMatch(/[^a-z0-9 |]/)
  }
})

it('answers nothing rather than everything when nothing was typed', () => {
  // The distinction matters: an empty tsquery must not become a match-all.
  for (const empty of ['', '   ', '!!!', 'a', '_']) {
    expect(buildSearchQuery(empty).tsquery).toBeNull()
  }
})

it('bounds the work one query can ask for', () => {
  const built = buildSearchQuery(Array.from({ length: 80 }, (_, n) => `term${n}`).join(' '))
  expect(built.terms).toHaveLength(12)
  // A single enormous word is not a term either.
  expect(buildSearchQuery('x'.repeat(300)).tsquery).toBeNull()
})

it('bridges how people ask to how agents describe themselves', () => {
  /*
   * The `english` dictionary stems "liquidation" and "liquidity" to the same
   * root, so a borrower asking to avoid liquidation ranks alongside every
   * liquidity-provision agent. Measured before the expansion existed: "protect
   * my loan from liquidation" put an LP rebalancer above the Venus health
   * factor guardian. These additions appear in lending agents and not in LP
   * agents, which is what separates them again.
   */
  const built = buildSearchQuery('protect my loan from liquidation')
  const added = built.expandedWith.map((e) => e.term)
  expect(added).toContain('health')
  expect(added).toContain('factor')
  expect(added).toContain('collateral')
  // Every addition carries its reason, so a ranking can be explained.
  expect(built.expandedWith.every((e) => e.why.length > 0)).toBe(true)
})

it('only ever adds, so a matching agent can never be expanded away', () => {
  for (const question of [
    'protect my loan from liquidation',
    'rebalance my lp',
    'earn better yield',
    'venus guardian',
  ]) {
    const built = buildSearchQuery(question)
    // Whatever the expander does, the user's own words are still in the query.
    for (const term of built.terms) expect(built.tsquery).toContain(term)
  }
})

it('does not repeat a term the user already typed', () => {
  const built = buildSearchQuery('health factor liquidation')
  const added = built.expandedWith.map((e) => e.term)
  expect(added).not.toContain('health')
  expect(added).not.toContain('factor')
  expect(new Set(added).size).toBe(added.length)
})
