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
