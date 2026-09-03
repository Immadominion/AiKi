import { describe, expect, it } from 'vitest'
import { InvalidAmountError } from './errors.js'
import { MAX_UINT256, parseBaseUnits, serializeBaseUnits, serializeMoney } from './money.js'

describe('marketplace money', () => {
  it.each(['0', '1', MAX_UINT256.toString()])('round-trips %s exactly', (value) => {
    expect(serializeBaseUnits(parseBaseUnits(value))).toBe(value)
  })

  it.each(['', '-1', '+1', '01', '1.0', '1e18', ' 1', '1 '])(
    'refuses the non-canonical amount %j',
    (value) => {
      expect(() => parseBaseUnits(value)).toThrow(InvalidAmountError)
    },
  )

  it('refuses values outside uint256', () => {
    expect(() => parseBaseUnits((MAX_UINT256 + 1n).toString())).toThrow('exceeds uint256')
    expect(() => parseBaseUnits('9'.repeat(100_000))).toThrow('exceeds uint256')
    expect(() => serializeBaseUnits(-1n)).toThrow('negative')
  })

  it('serializes an exact amount without turning it into a number', () => {
    const amount = 100_000_000_000_000_000_001n
    expect(
      serializeMoney({ chainId: 56, token: `0x${'ab'.repeat(20)}`, decimals: 18, amount }),
    ).toEqual({
      chainId: 56,
      token: `0x${'ab'.repeat(20)}`,
      decimals: 18,
      amount: '100000000000000000001',
    })
  })
})
