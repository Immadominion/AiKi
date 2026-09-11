import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatUnits, isZeroAmount } from './format'

/**
 * A balance is money on a screen. The two ways to get it wrong are showing more
 * than somebody has, and losing digits to a float, so both are pinned here.
 */

test('splits base units on the digits, not with arithmetic', () => {
  assert.equal(formatUnits('1000000000000000000', 18), '1')
  assert.equal(formatUnits('1500000000000000000', 18), '1.5')
  assert.equal(formatUnits('123456789', 6), '123.4567')
  assert.equal(formatUnits('0', 18), '0')
})

test('a balance too small to show is marked as under, never printed as zero', () => {
  // One wei of an eighteen-decimal token is real money and invisible at four
  // digits. Printing 0 here is the same lie as printing 0 for an unreadable
  // balance.
  assert.equal(formatUnits('1', 18), '<0.0001')
  assert.equal(formatUnits('1', 18, 6), '<0.000001')
  // Genuinely nothing still reads as nothing.
  assert.equal(formatUnits('0', 18), '0')
})

test('keeps full precision where a float would not', () => {
  // 12,345,678.9 of an eighteen-decimal token. Number() cannot hold this
  // exactly, so a divide-based implementation reports a different result.
  const raw = '12345678900000000000000000'
  assert.equal(formatUnits(raw, 18), '12,345,678.9')
  assert.notEqual(String(Number(raw) / 10 ** 18), '12345678.9')
})

test('never rounds a balance up', () => {
  assert.equal(formatUnits('999990000000000000', 18), '0.9999')
  assert.equal(formatUnits('1999999999999999999', 18), '1.9999')
})

test('groups thousands and trims trailing zeros', () => {
  assert.equal(formatUnits('1234567000000000000000', 18), '1,234.567')
  assert.equal(formatUnits('1000000', 6), '1')
})

test('handles zero decimals and a suppressed fraction', () => {
  assert.equal(formatUnits('4200', 0), '4,200')
  assert.equal(formatUnits('1500000000000000000', 18, 0), '1')
})

test('refuses anything that is not a base-unit integer', () => {
  assert.equal(formatUnits('1.5', 18), '0')
  assert.equal(formatUnits('', 18), '0')
  assert.equal(formatUnits('0x10', 18), '0')
})

test('tells an empty balance from a small one', () => {
  assert.equal(isZeroAmount('0'), true)
  assert.equal(isZeroAmount('000'), true)
  assert.equal(isZeroAmount('1'), false)
})
