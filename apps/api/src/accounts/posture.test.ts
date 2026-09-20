import { accountPosture, DUST_USD, formatAmount, money, usdOf } from '@aiki/contracts'
import { describe, expect, it } from 'vitest'

const ACCOUNT = '0x418ccdab06164b8b7fb8801d95e22d71aa9824bb'
const BNB_USD = 762.02
const prices = { bnbUsd: BNB_USD, usdtUsd: 1 }

describe('accountPosture', () => {
  it('never calls a dollar of BNB empty', () => {
    // The real account, on 20 Sept 2026: 0.0014 BNB, no tokens. It was being
    // reported as "empty", which sent its owner looking for money they had.
    const posture = accountPosture({
      address: ACCOUNT,
      balances: {
        native: '1400000000000000',
        tokens: [{ symbol: 'USDT', raw: '0', decimals: 18 }],
      },
      prices,
    })
    expect(posture.state).toBe('stranded')
    expect(posture.headline).toBe('$1.07 stuck in BNB')
    expect(posture.strandedUsd).toBeCloseTo(1.0668, 3)
    expect(posture.spendable).toEqual([])
    expect(posture.stranded[0]?.amount).toBe('0.0014')
    // The state that looks like poverty must carry the way out of it.
    expect(posture.fix).toEqual({ kind: 'convert', from: 'BNB', to: 'USDT', ownerSigned: true })
    expect(posture.detail).toContain('No mandate can move native BNB')
  })

  it('separates what an agent can spend from what only the owner can move', () => {
    const posture = accountPosture({
      address: ACCOUNT,
      balances: {
        native: '1400000000000000',
        tokens: [{ symbol: 'USDT', raw: '12400000000000000000', decimals: 18 }],
      },
      prices,
    })
    expect(posture.state).toBe('ready')
    expect(posture.headline).toBe('12.4 USDT')
    expect(posture.spendableUsd).toBeCloseTo(12.4, 6)
    // Held, and still reported, rather than hidden because it is unspendable.
    expect(posture.stranded[0]?.symbol).toBe('BNB')
    expect(posture.detail).toContain('cannot')
  })

  it('distinguishes nothing at all from something too small to use', () => {
    const empty = accountPosture({
      address: ACCOUNT,
      balances: { native: '0', tokens: [{ symbol: 'USDT', raw: '0', decimals: 18 }] },
      prices,
    })
    expect(empty.state).toBe('empty')
    expect(empty.fix).toEqual({ kind: 'fund', symbols: ['USDT'] })

    const dust = accountPosture({
      address: ACCOUNT,
      balances: {
        native: '0',
        tokens: [{ symbol: 'USDT', raw: '100000000000000000', decimals: 18 }],
      },
      prices,
    })
    expect(dust.state).toBe('dust')
    expect(dust.spendableUsd).toBeLessThan(DUST_USD)
    expect(dust.detail).toContain('gas and slippage')
  })

  it('an unreadable chain is never drawn as zeros, and a missing account says so', () => {
    const unreadable = accountPosture({ address: ACCOUNT, balances: null, prices })
    expect(unreadable.state).toBe('unreadable')
    expect(unreadable.spendableUsd).toBeNull()
    expect(unreadable.detail).toContain('does not mean the account is empty')

    const none = accountPosture({ address: null, balances: null })
    expect(none.state).toBe('no_account')
    expect(none.fix).toEqual({ kind: 'create' })
  })

  it('refuses to invent a total when it could not price every holding', () => {
    // A token nobody has a price for. Summing only the priced part would
    // understate the balance, which is the direction that loses money.
    const posture = accountPosture({
      address: ACCOUNT,
      balances: {
        native: '0',
        tokens: [
          { symbol: 'USDT', raw: '5000000000000000000', decimals: 18 },
          { symbol: 'SOMETHING', raw: '900000000000000000000', decimals: 18 },
        ],
      },
      prices,
    })
    expect(posture.spendableUsd).toBeNull()
    expect(posture.spendable.find((h) => h.symbol === 'SOMETHING')?.usd).toBeNull()
    expect(money(null)).toBe('unpriced')
  })

  it('prices and formats without floating point creeping into the balance', () => {
    expect(formatAmount('1400000000000000', 18)).toBe('0.0014')
    expect(formatAmount('0', 18)).toBe('0')
    expect(formatAmount('12400000000000000000', 18)).toBe('12.4')
    expect(usdOf('1400000000000000', 18, null)).toBeNull()
    expect(money(0.004)).toBe('<$0.01')
  })
})
