import { describe, expect, it } from 'vitest'
import { canonicalJson, hashCanonicalJson } from './canonical-json.js'

describe('canonical marketplace requests', () => {
  it('hashes equivalent objects identically regardless of key order', () => {
    const left = { z: [3, { b: true, a: null }], a: 'one' }
    const right = { a: 'one', z: [3, { a: null, b: true }] }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
    expect(hashCanonicalJson(left)).toBe(hashCanonicalJson(right))
  })

  it('preserves array order because it can change contract meaning', () => {
    expect(hashCanonicalJson(['a', 'b'])).not.toBe(hashCanonicalJson(['b', 'a']))
  })

  it('rejects values JSON would silently rewrite', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow('non-finite')
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow('non-finite')
  })
})
