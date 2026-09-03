import { describe, expect, it } from 'vitest'
import { MAX_UINT256 } from './domain/money.js'
import { quoteExactAmount } from './quote.js'

describe('exact marketplace quotes', () => {
  it('rounds a non-zero fee up in base units and conserves value', () => {
    expect(quoteExactAmount('1', 1)).toEqual({
      providerAmount: '1',
      platformFeeAmount: '1',
      totalAmount: '2',
    })
    expect(quoteExactAmount('10000', 250)).toEqual({
      providerAmount: '10000',
      platformFeeAmount: '250',
      totalAmount: '10250',
    })
  })

  it('never crosses a Number boundary for a uint256-sized amount', () => {
    expect(quoteExactAmount(MAX_UINT256.toString(), 0).totalAmount).toBe(MAX_UINT256.toString())
  })

  it('refuses an overflow after the fee is added', () => {
    expect(() => quoteExactAmount(MAX_UINT256.toString(), 1)).toThrow('exceeds uint256')
  })
})
