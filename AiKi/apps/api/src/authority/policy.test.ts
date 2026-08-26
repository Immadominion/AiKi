import { expect, it } from 'vitest'
import { compilePolicy, evaluatePolicy } from './policy.js'

it('denies off-allowlist and over-cap actions before execution', () => {
  const policy = compilePolicy([
    { kind: 'contract_allowlist', label: 'Venus only', value: ['0xvenus'], tier: 'T0' },
    { kind: 'per_action_cap', label: 'cap', value: '10', tier: 'T0' },
  ])
  expect(
    evaluatePolicy(
      policy,
      { target: '0xother', selector: '0x1', asset: 'u', amount: 1n, at: new Date().toISOString() },
      0n,
    ).allow,
  ).toBe(false)
  expect(
    evaluatePolicy(
      policy,
      { target: '0xvenus', selector: '0x1', asset: 'u', amount: 11n, at: new Date().toISOString() },
      0n,
    ).allow,
  ).toBe(false)
})

it('fails closed when the action timestamp cannot be read', () => {
  const policy = compilePolicy([
    { kind: 'expiry', label: 'Stops 30 September', value: '2026-09-30T00:00:00.000Z', tier: 'T0' },
  ])
  const action = {
    target: '0xabc',
    selector: '0x01',
    asset: '0xusdt',
    amount: 1n,
    at: 'not a time',
  }
  // NaN >= x is false, so the original comparison skipped the expiry check and
  // let a garbage timestamp walk past an expired mandate.
  const verdict = evaluatePolicy(policy, action, 0n)
  expect(verdict.allow).toBe(false)
  expect(verdict.rule).toBe('expiry')
})

it('refuses to compile an expiry it cannot read, rather than dropping it', () => {
  // A numeric expiry used to compile to a mandate with no expiry at all, while
  // the constraint still rendered in the UI as a limit.
  expect(() =>
    compilePolicy([{ kind: 'expiry', label: 'Stops soon', value: 1_798_761_600_000, tier: 'T0' }]),
  ).toThrow(/ISO-8601/)
  expect(() =>
    compilePolicy([{ kind: 'expiry', label: 'Stops soon', value: 'whenever', tier: 'T0' }]),
  ).toThrow(/ISO-8601/)
})
