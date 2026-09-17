import { actionMandateConstraints, swapVenueFor, tokenFor } from '@aiki/contracts'
import { expect, it } from 'vitest'
import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'
import { compileCaveats } from './caveats.js'
import { type Constraint, compilePolicy } from './policy.js'

/**
 * The builder's job is to produce a mandate the deployed enforcers will actually
 * hold, for work that is not repaying a Venus loan. So the tests check the shape
 * and then push it through the real compiler, because a constraint set that
 * cannot compile is a mandate nobody can sign.
 */

const TO = '0x00000000000000000000000000000000000000aa'
const OTHER = '0x00000000000000000000000000000000000000bb'

const base = {
  chainId: 56,
  symbol: 'USDT',
  recipients: [TO],
  can: ['send'] as const,
  perAction: 0.5,
  total: 1,
  expiresInDays: 7,
  ask: 'every' as const,
}

const build = (over: Partial<Parameters<typeof actionMandateConstraints>[0]> = {}) =>
  actionMandateConstraints({ ...base, can: [...base.can], ...over })

const byKind = (constraints: { kind: string; value: unknown; tier: string }[], kind: string) =>
  constraints.find((constraint) => constraint.kind === kind)

it('scopes a send to one token, one selector and one destination', () => {
  const constraints = build()
  expect(constraints.map((c) => c.kind)).toEqual([
    'expiry',
    'contract_allowlist',
    'selector_allowlist',
    'asset_scope',
    'per_action_cap',
    'session_total_cap',
    'recipient_allowlist',
    'approval',
  ])
  expect(byKind(constraints, 'selector_allowlist')?.value).toEqual(['0xa9059cbb'])
  expect(byKind(constraints, 'contract_allowlist')?.value).toEqual([tokenFor(56, 'USDT').address])
  expect(byKind(constraints, 'recipient_allowlist')?.value).toEqual([TO])
})

it('marks the two rules the chain does not hold, and only those', () => {
  // The destination and the approval gate. No enforcer reads a recipient, and
  // no contract can wait for a person, so neither may ever arrive as T0.
  for (const constraint of build())
    expect(constraint.tier).toBe(
      constraint.kind === 'recipient_allowlist' || constraint.kind === 'approval' ? 'T2' : 'T0',
    )
})

it('writes the approval gate in the vocabulary the policy engine reads', () => {
  expect(byKind(build({ ask: 'every' }), 'approval')?.value).toEqual({
    mode: 'approve_every',
    threshold: '0',
  })
  expect(byKind(build({ ask: 'never' }), 'approval')?.value).toEqual({
    mode: 'automatic',
    threshold: '0',
  })
  expect(byKind(build({ ask: 'over', askOver: 0.25 }), 'approval')?.value).toEqual({
    mode: 'approve_above_threshold',
    threshold: '250000000000000000',
  })
})

it('refuses a threshold the per-action cap already makes unreachable', () => {
  /*
   * The gate fires strictly above the threshold, and the cap refuses anything
   * above itself, so "ask me over 0.5" on a mandate capped at 0.5 never asks.
   * Somebody who chose to be asked would be told they had been.
   */
  expect(() => build({ ask: 'over', askOver: 0.5 })).toThrow(/would never ask/)
  expect(() => build({ ask: 'over', askOver: 0.75 })).toThrow(/would never ask/)
  expect(() => build({ ask: 'over' })).toThrow(/start asking over/)
})

it('refuses an approval mode it does not recognise', () => {
  expect(() => build({ ask: 'sometimes' as never })).toThrow(/asks before every action/)
})

it('converts caps exactly at eighteen decimals', () => {
  // The failure this guards is real history: a cap meant as 250 was sent as
  // 25000, which at eighteen decimals is a ten-thousandth of a millionth of a
  // token, and every action would have been refused.
  const constraints = build({ perAction: 0.5, total: 250 })
  expect(byKind(constraints, 'per_action_cap')?.value).toBe('500000000000000000')
  expect(byKind(constraints, 'session_total_cap')?.value).toBe('250000000000000000000')
})

it('refuses a mandate with nowhere named', () => {
  expect(() => build({ recipients: [] })).toThrow(/at least one address/)
})

it('refuses an address that is not one', () => {
  expect(() => build({ recipients: ['0xnope'] })).toThrow(/not an address/)
  expect(() => build({ recipients: ['0x0000000000000000000000000000000000000000'] })).toThrow(
    /not an address/,
  )
})

it('refuses a per-action cap above the total', () => {
  expect(() => build({ perAction: 2, total: 1 })).toThrow(/cannot exceed/)
})

it('refuses a token this network has not reviewed', () => {
  expect(() => build({ symbol: 'DOGE' })).toThrow(/no reviewed token called DOGE/)
  // Testnet has no WBNB in its list, and saying so names what is available.
  expect(() => build({ chainId: 97, symbol: 'WBNB' })).toThrow(/Choose one of: USDT/)
})

it('refuses an expiry outside one to 365 whole days', () => {
  for (const expiresInDays of [0, 366, 1.5, Number.NaN])
    expect(() => build({ expiresInDays })).toThrow(/between 1 and 365/)
})

it('refuses an empty capability list', () => {
  expect(() => build({ can: [] })).toThrow(/what the agent may do/)
})

it('dedupes and lowercases what it was given', () => {
  const constraints = build({
    recipients: [TO.toUpperCase(), TO, OTHER],
    can: ['send', 'send', 'approve'],
  })
  expect(byKind(constraints, 'recipient_allowlist')?.value).toEqual([TO, OTHER])
  expect(byKind(constraints, 'selector_allowlist')?.value).toEqual(['0xa9059cbb', '0x095ea7b3'])
})

it('refuses more addresses than an enforcer can hold', () => {
  const many = Array.from(
    { length: 33 },
    (_v, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
  )
  expect(() => build({ recipients: many })).toThrow(/at most 32/)
})

it('compiles into caveats the deployed suite holds, with two rules left to AiKi', () => {
  const constraints = build({ can: ['send', 'approve'] }) as Constraint[]
  // It is a mandate the policy engine accepts.
  expect(compilePolicy(constraints).weakestTier).toBe('T2')

  const { caveats, outcomes } = compileCaveats(constraints, AIKI_ENFORCERS_BSC_TESTNET)
  // Six rules reach the chain: expiry, targets, selectors, asset, and both caps.
  expect(caveats).toHaveLength(6)
  expect(outcomes.filter((outcome) => outcome.tier === 'T0')).toHaveLength(6)
  /*
   * Two do not, and the count is asserted so that adding a soft rule later
   * cannot quietly pass for a hard one. The approval gate compiles to no caveat
   * at all, which is the honest outcome: the chain takes a transaction or it
   * does not, and it cannot hold one until somebody answers.
   */
  const soft = outcomes.filter((outcome) => outcome.tier === 'T2')
  expect(soft.map((outcome) => outcome.constraint.kind).sort()).toEqual([
    'approval',
    'recipient_allowlist',
  ])
  expect(soft.every((outcome) => outcome.enforcer === null)).toBe(true)
})

it('labels what it permits in words a person can check', () => {
  const labels = build({ can: ['send', 'approve'], perAction: 0.5, total: 1 }).map((c) => c.label)
  expect(labels).toContain('only send it and let a contract take it')
  expect(labels).toContain('0.5 USDT per action')
  expect(labels).toContain('1 USDT in total')
  expect(labels).toContain(`only to ${TO}`)
})

/*
 * A swap, capped on chain.
 *
 * AiKi told people for weeks that it "genuinely cannot" trade, because "the cap
 * enforcers cannot read an amount out of a swap". Both halves were false.
 * PerActionCapEnforcer takes max(declared, realised), and realised is a
 * balanceOf delta its own comment calls "decode-free, so it survives proxies,
 * multicall wrappers and an ABI nobody anticipated". A swap is exactly that.
 * The declared half needed one table entry, verified against a real encoding.
 */
const swapBuild = () =>
  build({
    can: ['swap'],
    account: `0x${'dd'.repeat(20)}`,
  }) as Constraint[]

it('permits the router as well as the token, and nothing else', () => {
  const targets = byKind(swapBuild(), 'contract_allowlist')?.value as string[]
  expect(targets).toEqual([tokenFor(56, 'USDT').address, swapVenueFor(56)?.router])
})

it('carries the approve leg, because a router moves tokens with transferFrom', () => {
  // A mandate permitting only the swap selector describes a call that always
  // reverts: the account has to approve the router first.
  const selectors = byKind(swapBuild(), 'selector_allowlist')?.value as string[]
  expect(selectors).toContain('0x04e45aaf')
  expect(selectors).toContain('0x095ea7b3')
})

it('sends the proceeds back to the account and lets the router be approved', () => {
  /*
   * The caps measure the token going OUT. What comes back is a different asset
   * they say nothing about, so without this an agent allowed to swap could keep
   * the proceeds anywhere it liked and no limit would notice.
   */
  const recipients = byKind(swapBuild(), 'recipient_allowlist')?.value as string[]
  expect(recipients).toContain(`0x${'dd'.repeat(20)}`)
  expect(recipients).toContain(swapVenueFor(56)?.router)
})

it('refuses a swap mandate with nowhere for the proceeds to land', () => {
  expect(() => build({ can: ['swap'] })).toThrow(/bought tokens return to/)
})

it('compiles the swap caps onto the chain, not into a promise', () => {
  /*
   * The point of the whole exercise. If the amount site were missing the cap
   * would compile soft, and AiKi would be claiming a limit the chain does not
   * hold, which is the one thing this product must never do.
   */
  const { caveats, outcomes } = compileCaveats(swapBuild(), AIKI_ENFORCERS_BSC_TESTNET)
  expect(caveats).toHaveLength(6)
  const caps = outcomes.filter(
    (o) => o.constraint.kind === 'per_action_cap' || o.constraint.kind === 'session_total_cap',
  )
  expect(caps).toHaveLength(2)
  expect(caps.every((o) => o.tier === 'T0')).toBe(true)
})
