import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  acceptedTokens,
  fundingContinuations,
  parseFundingContinuation,
  swapUrl,
} from './fast-funding'

/**
 * The address, as something you press.
 *
 * Somebody asked an agent to trade a dollar for them, was correctly told native
 * BNB cannot be spent and an account needed funding, and did not find the
 * address. It was the fortieth word of the first paragraph. They went to a
 * different screen and made a second wallet instead.
 */

const ADDRESS = `0x${'ab'.repeat(20)}`
const action = { kind: 'fund_account', address: ADDRESS, chainId: 56, symbols: ['USDT', 'WBNB'] }

test('offers the control only from the tool that read the account', () => {
  assert.equal(fundingContinuations([{ tool: 'my_account', ok: true, action }]).length, 1)
  // Another tool's step must not be able to put an address on the screen.
  assert.equal(fundingContinuations([{ tool: 'send_token', ok: true, action }]).length, 0)
  assert.equal(fundingContinuations([{ tool: 'my_account', ok: false, action }]).length, 0)
})

test('shows one control per account, however often a step repeats it', () => {
  assert.equal(
    fundingContinuations([
      { tool: 'my_account', ok: true, action },
      { tool: 'my_account', ok: true, action },
    ]).length,
    1,
  )
})

test('refuses anything that is not an address somebody could send to', () => {
  for (const broken of [
    { ...action, address: '0xnope' },
    { ...action, address: `0x${'0'.repeat(40)}` },
    { ...action, chainId: 1 },
    { ...action, symbols: [] },
    { ...action, kind: 'something_else' },
    null,
  ])
    assert.equal(parseFundingContinuation(broken), null, JSON.stringify(broken))
})

test('names what may be sent without turning it into a sentence', () => {
  assert.equal(acceptedTokens(['USDT']), 'USDT')
  assert.equal(acceptedTokens(['USDT', 'WBNB']), 'USDT or WBNB')
})

test('points a stuck BNB holder at the swap, on their own chain', () => {
  // The one thing somebody holding only BNB can do, and they cannot do it here.
  assert.match(swapUrl(56, ['USDT', 'WBNB']), /chain=bsc&outputCurrency=USDT/)
  assert.match(swapUrl(97, ['USDT']), /chain=bscTestnet/)
})
