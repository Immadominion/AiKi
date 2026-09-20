import assert from 'node:assert/strict'
import { test } from 'node:test'
import { walletLabel } from './FastWallet'

const ready = (balances: unknown) =>
  ({
    kind: 'ready' as const,
    address: '0x1',
    chainId: 56,
    network: 'BNB Smart Chain',
    balances,
    // biome-ignore lint/suspicious/noExplicitAny: the shape under test is the balance payload
  }) as any

test('an unreadable balance never reads as an empty one', () => {
  // These two look the same as zeros on screen and mean opposite things to
  // somebody who has just deposited.
  assert.equal(walletLabel(ready(null)), 'unreadable')
  assert.equal(walletLabel({ kind: 'failed', message: 'x' }), 'unreadable')
  assert.equal(walletLabel(ready({ native: '0', tokens: [] })), 'empty')
})

test('reports what an agent can actually spend, not what the account holds', () => {
  // Native BNB is held but unspendable by any mandate, so it is not the answer
  // to "can this be done with what I have".
  const onlyNative = ready({ native: '5000000000000000000', tokens: [] })
  assert.equal(walletLabel(onlyNative), 'empty')

  const funded = ready({
    native: '5000000000000000000',
    tokens: [{ symbol: 'USDT', raw: '12400000000000000000', decimals: 18 }],
  })
  assert.equal(walletLabel(funded), '12.40 USDT')
})

test('says so plainly when there is no account yet', () => {
  assert.equal(walletLabel({ kind: 'none' }), 'not created')
})
