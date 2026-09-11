import { actionMandateConstraints, tokenFor } from '@aiki/contracts'
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
  ])
  expect(byKind(constraints, 'selector_allowlist')?.value).toEqual(['0xa9059cbb'])
  expect(byKind(constraints, 'contract_allowlist')?.value).toEqual([tokenFor(56, 'USDT').address])
  expect(byKind(constraints, 'recipient_allowlist')?.value).toEqual([TO])
})

it('marks only the destination rule as one the chain does not hold', () => {
  for (const constraint of build())
    expect(constraint.tier).toBe(constraint.kind === 'recipient_allowlist' ? 'T2' : 'T0')
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

it('compiles into caveats the deployed suite holds, with the destination left to AiKi', () => {
  const constraints = build({ can: ['send', 'approve'] }) as Constraint[]
  // It is a mandate the policy engine accepts.
  expect(compilePolicy(constraints).weakestTier).toBe('T2')

  const { caveats, outcomes } = compileCaveats(constraints, AIKI_ENFORCERS_BSC_TESTNET)
  // Six rules reach the chain: expiry, targets, selectors, asset, and both caps.
  expect(caveats).toHaveLength(6)
  expect(outcomes.filter((outcome) => outcome.tier === 'T0')).toHaveLength(6)
  const soft = outcomes.filter((outcome) => outcome.tier === 'T2')
  expect(soft).toHaveLength(1)
  expect(soft[0]?.constraint.kind).toBe('recipient_allowlist')
})

it('labels what it permits in words a person can check', () => {
  const labels = build({ can: ['send', 'approve'], perAction: 0.5, total: 1 }).map((c) => c.label)
  expect(labels).toContain('only send it and let a contract take it')
  expect(labels).toContain('0.5 USDT per action')
  expect(labels).toContain('1 USDT in total')
  expect(labels).toContain(`only to ${TO}`)
})
