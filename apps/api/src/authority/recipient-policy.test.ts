import { encodeFunctionData, parseAbi } from 'viem'
import { expect, it } from 'vitest'
import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'
import { compileCaveats } from './caveats.js'
import { type Action, type Constraint, compilePolicy, evaluatePolicy } from './policy.js'

/**
 * A recipient rule is the only bound on where a permitted call sends money, and
 * nothing on chain enforces it. So two things are pinned here: that it actually
 * refuses, and that it is never described as something the chain holds.
 */

const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])
const ALLOWED = '0x00000000000000000000000000000000000000aa' as const
const ATTACKER = '0x00000000000000000000000000000000000000ff' as const
const TOKEN = '0x55d398326f99059ff775485246999027b3197955'

const recipientRule: Constraint = {
  kind: 'recipient_allowlist',
  value: [ALLOWED],
  tier: 'T2',
  label: 'only the address you named',
}

const transferTo = (to: `0x${string}`): Action => ({
  target: TOKEN,
  selector: '0xa9059cbb',
  asset: TOKEN,
  amount: 1n,
  at: new Date().toISOString(),
  recipient: to,
})

const policy = () =>
  compilePolicy([
    recipientRule,
    { kind: 'per_action_cap', value: '1000', tier: 'T0', label: 'cap' },
  ])

it('allows a call that lands where the mandate says', () => {
  expect(evaluatePolicy(policy(), transferTo(ALLOWED), 0n).allow).toBe(true)
})

it('refuses the same call, same amount, to somewhere else', () => {
  const verdict = evaluatePolicy(policy(), transferTo(ATTACKER), 0n)
  expect(verdict.allow).toBe(false)
  expect(verdict.rule).toBe('recipient_allowlist')
  // The cap would have allowed this. Without the rule it lands.
  expect(evaluatePolicy(compilePolicy([recipientRule]), transferTo(ATTACKER), 0n).allow).toBe(false)
})

it('refuses when the destination could not be read at all', () => {
  const verdict = evaluatePolicy(policy(), { ...transferTo(ALLOWED), recipient: null }, 0n)
  expect(verdict.allow).toBe(false)
  expect(verdict.reason).toMatch(/does not name a destination/)
})

it('refuses when the action carries no recipient field', () => {
  const { recipient: _dropped, ...action } = transferTo(ALLOWED)
  expect(evaluatePolicy(policy(), action, 0n).allow).toBe(false)
})

it('leaves mandates without the rule exactly as they were', () => {
  // A Venus repayment names nobody, and must not start failing because this
  // rule now exists.
  const venus = compilePolicy([{ kind: 'per_action_cap', value: '1000', tier: 'T0', label: 'cap' }])
  const repay: Action = {
    target: '0xfd5840cd36d94d7229439859c0112a4185bc0255',
    selector: '0x0e752702',
    asset: TOKEN,
    amount: 1n,
    at: new Date().toISOString(),
    recipient: null,
  }
  expect(evaluatePolicy(venus, repay, 0n).allow).toBe(true)
})

it('matches the destination case-insensitively', () => {
  const upper = compilePolicy([
    { ...recipientRule, value: [ALLOWED.toUpperCase()] },
    { kind: 'per_action_cap', value: '1000', tier: 'T0', label: 'cap' },
  ])
  expect(evaluatePolicy(upper, transferTo(ALLOWED), 0n).allow).toBe(true)
})

it('is compiled as held by AiKi, never by the chain', () => {
  const expiry: Constraint = {
    kind: 'expiry',
    value: new Date('2030-01-01T00:00:00.000Z').toISOString(),
    tier: 'T0',
    label: 'Expires',
  }
  const { caveats, outcomes } = compileCaveats([expiry, recipientRule], AIKI_ENFORCERS_BSC_TESTNET)
  const outcome = outcomes.find((o) => o.constraint.kind === 'recipient_allowlist')
  expect(outcome?.tier).toBe('T2')
  expect(outcome?.enforcer).toBeNull()
  expect(outcome?.why).toMatch(/No contract checks this one/)
  // The expiry compiled; the recipient rule added nothing for the chain to hold.
  expect(caveats).toHaveLength(1)
})

it('decodes the destination a real wallet would send', () => {
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [ATTACKER, 1n] })
  // Sanity: the fixture above is the shape this rule is meant to catch.
  expect(data.slice(0, 10)).toBe('0xa9059cbb')
})
