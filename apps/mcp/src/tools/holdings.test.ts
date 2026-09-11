import { expect, it } from 'vitest'
import { holdings } from './wallet.js'

/**
 * Every case is the same question: can somebody who just funded this address be
 * told it is empty? Unknown and zero look alike on a line of text and mean
 * opposite things, so each path is pinned separately.
 */

const usdt = (raw: string) => ({ symbol: 'USDT', decimals: 18, raw })

it('reports an unreadable chain as unknown, never as empty', () => {
  for (const value of [null, {}, { balances: null }, { balances: {} }]) {
    const lines = holdings(value)
    expect(lines.join(' ')).toMatch(/could not be read/)
    expect(lines.join(' ')).not.toMatch(/0 BNB/)
  }
})

it('lists native separately and says no mandate can move it', () => {
  const lines = holdings({ balances: { native: '5000000000000000000', tokens: [usdt('0')] } })
  expect(lines[0]).toMatch(/5 BNB \(no mandate can move this\)/)
  expect(lines[0]).toMatch(/0 USDT/)
})

it('says an account holding only BNB has nothing an agent can spend', () => {
  const lines = holdings({ balances: { native: '5000000000000000000', tokens: [usdt('0')] } })
  expect(lines.join(' ')).toMatch(/nothing an agent can spend yet/)
})

it('stops saying that as soon as any token has a balance', () => {
  const lines = holdings({ balances: { native: '0', tokens: [usdt('1')] } })
  expect(lines.join(' ')).not.toMatch(/nothing an agent can spend/)
})

it('splits base units on the digits rather than dividing', () => {
  // Number() cannot hold this exactly; a divide-based version reports a
  // different whole part.
  const lines = holdings({
    balances: { native: '0', tokens: [usdt('12345678900000000000000000')] },
  })
  expect(lines[0]).toMatch(/12345678\.9 USDT/)
})

it('never rounds a balance up', () => {
  const lines = holdings({ balances: { native: '999999999999999999', tokens: [] } })
  expect(lines[0]).toMatch(/0\.999999 BNB/)
})

it('drops a token entry that is not shaped like one rather than printing junk', () => {
  const lines = holdings({
    balances: { native: '0', tokens: [usdt('2500000000000000000'), { symbol: 'X' }, null] },
  })
  expect(lines[0]).toMatch(/2\.5 USDT/)
  expect(lines[0]).not.toMatch(/ X/)
})

it('says a balance too small to display is under the smallest shown, not zero', () => {
  // One wei of an eighteen-decimal token. Real, and invisible at six digits.
  const lines = holdings({ balances: { native: '0', tokens: [usdt('1')] } })
  expect(lines[0]).toMatch(/<0\.000001 USDT/)
  expect(lines.join(' ')).not.toMatch(/nothing an agent can spend/)
})
