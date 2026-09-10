import { ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import type { StrategyBinding } from '@aiki/contracts/strategies'
import { decodeAbiParameters, encodeAbiParameters, type Hex, keccak256, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { SignedDelegation } from '../execution/executor.js'
import { assertStrategyGrant, encodeStrategyBindingTerms } from './grant.js'
import { encodeStrategyOperation } from './operation.js'
import { a, gridOp, h, lpOp, yieldOp } from './receipt.test-support.js'

const bindingEnforcer = a('ee'),
  executor = a('66')
// Deliberately only structurally valid. This unit helper does not authenticate the owner.
const signature = `${h('01')}${h('01').slice(2)}1b` as Hex
const termsAbi = [
  { type: 'address' },
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'bytes4' },
  { type: 'bytes32' },
] as const
const kindLabels = {
  yield: 'aiki.yield-allocation.v1',
  grid: 'AIKI_PANCAKE_GRID_V1',
  lp: 'AIKI_PANCAKE_LP_V1',
}

function fixture(binding: StrategyBinding = yieldOp.binding) {
  const delegation: SignedDelegation = {
    delegate: executor,
    delegator: binding.controller,
    authority: ROOT_AUTHORITY,
    caveats: [
      { enforcer: bindingEnforcer, terms: encodeStrategyBindingTerms(binding), args: '0x' },
    ],
    salt: 1n,
    epoch: 0n,
    signature,
  }
  return { binding, delegation, executor, bindingEnforcer }
}

function caveat(input: ReturnType<typeof fixture>, index = 0) {
  const value = input.delegation.caveats[index]
  if (!value) throw new Error('Missing test caveat')
  return value
}

describe('signed strategy binding admission', () => {
  it.each([yieldOp, gridOp, lpOp])(
    'accepts exactly the reviewed $kind vault operation binding',
    (operation) => {
      const input = fixture(operation.binding)
      const terms = encodeStrategyBindingTerms(operation.binding)
      expect(terms.length).toBe(2 + 160 * 2)
      expect(decodeAbiParameters(termsAbi, terms)).toEqual([
        operation.binding.vault,
        operation.binding.policyHash,
        operation.binding.runtimeCodeHash,
        encodeStrategyOperation(operation).slice(0, 10),
        keccak256(stringToHex(kindLabels[operation.kind])),
      ])
      expect(() => assertStrategyGrant(input)).not.toThrow()
    },
  )
  it('allows further signed restrictions, but does not invent or remove a binding caveat', () => {
    const input = fixture()
    input.delegation.caveats.unshift({ enforcer: a('ab'), terms: '0x12', args: '0x' })
    const before = structuredClone(input)
    assertStrategyGrant(input)
    expect(input).toEqual(before)
    input.delegation.caveats.pop()
    expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
  })
  it('accepts equivalent hexadecimal casing, not noncanonical ABI padding', () => {
    const input = fixture()
    const upper = (value: Hex) => `0x${value.slice(2).toUpperCase()}` as Hex
    input.bindingEnforcer = upper(input.bindingEnforcer)
    input.executor = upper(input.executor)
    caveat(input).terms = upper(caveat(input).terms)
    expect(() => assertStrategyGrant(input)).not.toThrow()
    const valid = encodeStrategyBindingTerms(input.binding)
    for (const terms of [
      `0x01${valid.slice(4)}`,
      `${valid.slice(0, 202)}01${valid.slice(204)}`,
    ] as Hex[]) {
      caveat(input).terms = terms
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    }
  })
  it.each([0, 1, 2, 3, 4])('rejects different binding field %s', (field) => {
    const input = fixture()
    const values = [...decodeAbiParameters(termsAbi, encodeStrategyBindingTerms(input.binding))]
    values[field] = field === 0 ? a('ab') : field === 3 ? '0x12345678' : h('ab')
    caveat(input).terms = encodeAbiParameters(
      termsAbi,
      values as unknown as readonly [Hex, Hex, Hex, Hex, Hex],
    )
    expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
  })
  it('rejects truncated, appended, malformed and absent terms', () => {
    const input = fixture(),
      valid = caveat(input).terms
    for (const terms of ['0x', valid.slice(0, -2), `${valid}00`, `${valid}0`, '0xzz'] as Hex[]) {
      caveat(input).terms = terms
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    }
  })
  it('requires exactly one caveat at the supplied reviewed enforcer, not a lookalike address', () => {
    const input = fixture(),
      original = structuredClone(caveat(input))
    caveat(input).enforcer = a('ab')
    expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    input.delegation.caveats = [original, { ...original }]
    expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    caveat(input, 1).terms = '0x'
    expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    input.delegation.caveats = []
    expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
  })
  it.each(['delegator', 'delegate', 'authority'] as const)(
    'rejects different delegation %s',
    (field) => {
      const input = fixture()
      input.delegation[field] = field === 'authority' ? h('ab') : a('ab')
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    },
  )
  it.each(['bindingEnforcer', 'executor'] as const)('requires a nonzero reviewed %s', (field) => {
    const input = fixture()
    for (const value of [a('00'), '0x', '0xzz'] as Hex[]) {
      input[field] = value
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    }
  })
  it('rejects unsigned per-call args even on an additional restriction', () => {
    for (const additional of [false, true]) {
      const input = fixture()
      if (additional)
        input.delegation.caveats.push({ enforcer: a('ab'), terms: '0x', args: '0x01' })
      else caveat(input).args = '0x00'
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    }
  })
  it.each(['salt', 'epoch'] as const)('requires an exact uint256 %s without coercion', (field) => {
    for (const value of [-1n, 1n << 256n, '1', 1, null]) {
      const input = fixture()
      Object.assign(input.delegation, { [field]: value })
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    }
    const input = fixture()
    input.delegation[field] = (1n << 256n) - 1n
    expect(() => assertStrategyGrant(input)).not.toThrow()
  })
  it('rejects missing or noncanonical account signature shapes without claiming to authenticate one', () => {
    const input = fixture(),
      r = h('01'),
      s = h('01').slice(2)
    const order = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
    for (const invalid of [
      '0x',
      '0x1234',
      `${signature}00`,
      `${r}${s}00`,
      `${r}${s}1d`,
      `${h('00')}${s}1b`,
      `${r}${'00'.repeat(32)}1b`,
      `0x${order}${s}1b`,
      `${r}${order}1b`,
      `0x${'gg'.repeat(65)}`,
    ] as Hex[]) {
      input.delegation.signature = invalid
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    }
    input.delegation.signature = `${r}${s}1c`
    expect(() => assertStrategyGrant(input)).not.toThrow()
  })
  it('rejects non-mainnet, malformed or unsupported vault bindings', () => {
    for (const change of [
      { chainId: 97 },
      { version: 2 },
      { kind: 'swap' },
      { vault: a('00') },
      { policyHash: h('00') },
      { runtimeCodeHash: h('00') },
      { controller: yieldOp.binding.vault },
    ]) {
      const input = fixture()
      input.binding = { ...input.binding }
      Object.assign(input.binding, change)
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
      expect(() => encodeStrategyBindingTerms(input.binding)).toThrow(
        'Invalid signed strategy grant.',
      )
    }
  })
  it('sanitizes malformed untyped input instead of leaking payload data', () => {
    for (const delegation of [
      null,
      {},
      { ...fixture().delegation, caveats: null },
      { ...fixture().delegation, caveats: [null] },
      {
        ...fixture().delegation,
        caveats: [{ enforcer: a('ab'), terms: 'private payload', args: '0x' }],
      },
    ]) {
      const input = { ...fixture(), delegation: delegation as SignedDelegation }
      expect(() => assertStrategyGrant(input)).toThrow('Invalid signed strategy grant.')
    }
  })
})
