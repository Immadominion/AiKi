import { describe, expect, it } from 'vitest'
import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'
import { compileCaveats, overallTier } from './caveats.js'
import type { Constraint } from './policy.js'

const D = AIKI_ENFORCERS_BSC_TESTNET
const addr = (name: string) => D.enforcers.find((e) => e.name === name)?.address
const TOKEN = '0x55d398326f99059ff775485246999027b3197955'
const VENUS = '0xfd36e2c2a6789db23113685031d7f16329158384'
const TRANSFER = '0xa9059cbb'

const expiry = (): Constraint => ({
  kind: 'expiry',
  value: new Date('2030-01-01T00:00:00.000Z').toISOString(),
  tier: 'T0',
  label: 'Expires',
})
const scoped = (): Constraint[] => [
  { kind: 'contract_allowlist', value: [VENUS], tier: 'T0', label: 'Venus only' },
  { kind: 'selector_allowlist', value: [TRANSFER], tier: 'T0', label: 'transfer only' },
  { kind: 'asset_scope', value: [TOKEN], tier: 'T0', label: 'USDT only' },
]

describe('compiling a mandate into caveats the chain holds', () => {
  it('puts the expiry first, because the manager reads caveats[0]', () => {
    // Not a preference: AiKiDelegationManager reverts MissingExpiryCaveat when
    // caveats[0].enforcer is not the expiry enforcer it was constructed with, so
    // that unbounded standing authority cannot be signed by accident.
    const { caveats } = compileCaveats([...scoped(), expiry()], D)
    expect(caveats[0]?.enforcer).toBe(addr('ExpiryEnforcer'))
  })

  it('refuses to compile a mandate with no expiry at all', () => {
    expect(() => compileCaveats(scoped(), D)).toThrow(/must carry an expiry/)
  })

  it('packs allowlists unpadded, the way the enforcers slice them', () => {
    const { caveats } = compileCaveats([expiry(), ...scoped()], D)
    const targets = caveats.find((c) => c.enforcer === addr('AllowedTargetsEnforcer'))
    const selectors = caveats.find((c) => c.enforcer === addr('AllowedSelectorsEnforcer'))
    // 20 bytes per address, 4 per selector, no padding: the enforcers reject
    // terms whose length is not an exact multiple.
    expect(targets?.terms).toBe(VENUS)
    expect((targets?.terms.length ?? 0) - 2).toBe(40)
    expect(selectors?.terms).toBe(TRANSFER)
    expect((selectors?.terms.length ?? 0) - 2).toBe(8)
  })

  it('will not turn an empty allowlist into an allow-all', () => {
    // Empty terms mean "no restriction" to the enforcer. A mandate that lists
    // nothing must not compile into one that permits everything.
    const { caveats, outcomes } = compileCaveats(
      [expiry(), { kind: 'contract_allowlist', value: [], tier: 'T0', label: 'none' }],
      D,
    )
    expect(caveats).toHaveLength(1)
    const outcome = outcomes.find((o) => o.constraint.kind === 'contract_allowlist')
    expect(outcome?.tier).toBe('T2')
    expect(outcome?.why).toMatch(/empty/)
  })

  it('refuses a cap it has no way to read an amount for', () => {
    // No scope means no AmountSite, and the cap enforcers fail closed on a site
    // that does not resolve. A cap the chain cannot price is not a cap, so it
    // must come back T2 rather than as a caveat that reverts everything.
    const { outcomes } = compileCaveats(
      [expiry(), { kind: 'per_action_cap', value: '10', tier: 'T0', label: '10' }],
      D,
    )
    const cap = outcomes.find((o) => o.constraint.kind === 'per_action_cap')
    expect(cap?.tier).toBe('T2')
    expect(overallTier(outcomes)).toBe('T2')
  })

  it('refuses a cap on a selector whose amount position is unknown', () => {
    // "Unknown selector, so the amount is zero" is a total bypass of every cap.
    const { outcomes } = compileCaveats(
      [
        expiry(),
        { kind: 'contract_allowlist', value: [VENUS], tier: 'T0', label: 't' },
        { kind: 'selector_allowlist', value: ['0xdeadbeef'], tier: 'T0', label: 's' },
        { kind: 'asset_scope', value: [TOKEN], tier: 'T0', label: 'a' },
        { kind: 'per_action_cap', value: '10', tier: 'T0', label: 'cap' },
      ],
      D,
    )
    expect(outcomes.find((o) => o.constraint.kind === 'per_action_cap')?.tier).toBe('T2')
  })

  it('compiles a fully scoped mandate to on-chain enforcement throughout', () => {
    const constraints: Constraint[] = [
      expiry(),
      ...scoped(),
      { kind: 'per_action_cap', value: '10000000000000000000', tier: 'T0', label: '10 USDT' },
      { kind: 'session_total_cap', value: '50000000000000000000', tier: 'T0', label: '50 USDT' },
    ]
    const { caveats, outcomes } = compileCaveats(constraints, D)
    expect(outcomes.every((o) => o.tier === 'T0')).toBe(true)
    expect(overallTier(outcomes)).toBe('T0')
    expect(caveats).toHaveLength(6)
    expect(caveats.map((c) => c.enforcer)).toEqual([
      addr('ExpiryEnforcer'),
      addr('AllowedTargetsEnforcer'),
      addr('AllowedSelectorsEnforcer'),
      addr('AssetScopeEnforcer'),
      addr('PerActionCapEnforcer'),
      addr('SessionTotalCapEnforcer'),
    ])
  })

  it('emits one cap per asset, and says that is what it did', () => {
    // A cap is denominated in exactly one asset; the enforcer refuses a call that
    // moves a different one rather than pricing it. Two assets in scope therefore
    // means ten of each, not ten across both, and the reason has to say so
    // because "ten" reads as a total.
    const OTHER = '0xe9e7cea3dedca5984780bafc599bd69add087d56'
    const { caveats, outcomes } = compileCaveats(
      [
        expiry(),
        { kind: 'contract_allowlist', value: [VENUS], tier: 'T0', label: 't' },
        { kind: 'selector_allowlist', value: [TRANSFER], tier: 'T0', label: 's' },
        { kind: 'asset_scope', value: [TOKEN, OTHER], tier: 'T0', label: 'two assets' },
        { kind: 'per_action_cap', value: '10', tier: 'T0', label: '10' },
      ],
      D,
    )
    expect(caveats.filter((c) => c.enforcer === addr('PerActionCapEnforcer'))).toHaveLength(2)
    expect(outcomes.find((o) => o.constraint.kind === 'per_action_cap')?.why).toMatch(
      /separately for each of the 2 assets/,
    )
  })

  it('never claims T0 for a constraint no contract can hold', () => {
    const { outcomes } = compileCaveats(
      [
        expiry(),
        { kind: 'condition', value: { note: 'only when healthy' }, tier: 'T0', label: 'c' },
      ],
      D,
    )
    const condition = outcomes.find((o) => o.constraint.kind === 'condition')
    expect(condition?.tier).toBe('T2')
    expect(condition?.enforcer).toBeNull()
    // The headline is the weakest link, never the best or the average.
    expect(overallTier(outcomes)).toBe('T2')
  })

  it('refuses an allowlist longer than the chain will accept', () => {
    const many = Array.from({ length: 33 }, (_, i) => `0x${String(i).padStart(40, '0')}`)
    const { outcomes } = compileCaveats(
      [expiry(), { kind: 'contract_allowlist', value: many, tier: 'T0', label: 'many' }],
      D,
    )
    expect(outcomes.find((o) => o.constraint.kind === 'contract_allowlist')?.tier).toBe('T2')
  })
})
