import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountHeadline, agentWalletLine, balanceView, explorerAccountUrl } from './agent-account'

const usdt = (raw: string) => ({
  address: '0x55d398326f99059ff775485246999027b3197955',
  symbol: 'USDT',
  decimals: 18,
  raw,
})

test('an unreadable chain is never rendered as an empty account', () => {
  const view = balanceView(null)
  assert.equal(view.unknown, true)
  assert.equal(view.rows.length, 0)
  assert.equal(view.needsFunding, false)
  assert.match(view.summary, /could not be read/)
  assert.doesNotMatch(view.summary, /^Empty/)
})

test('undefined balances are treated as unreadable, not as zero', () => {
  assert.equal(balanceView(undefined).unknown, true)
})

test('an account with none of the reviewed tokens asks to be funded', () => {
  const view = balanceView({ native: '0', tokens: [usdt('0')] })
  assert.equal(view.unknown, false)
  assert.equal(view.needsFunding, true)
  assert.match(view.summary, /No USDT here/)
  // Never "empty": only reviewed tokens are read, so an account holding
  // something else would be told its money is not there.
  assert.doesNotMatch(view.summary, /^Empty/)
  assert.match(view.summary, /Other tokens may be in this account/)
})

test('an account holding only BNB still needs funding, and says why', () => {
  const view = balanceView({ native: '5000000000000000000', tokens: [usdt('0')] })
  assert.equal(view.needsFunding, true)
  assert.match(view.summary, /Holds BNB, which no agent can spend/)
  const native = view.rows[0]
  assert.equal(native?.symbol, 'BNB')
  assert.equal(native?.amount, '5')
  assert.equal(native?.spendable, false)
  assert.match(String(native?.note), /no agent can move it/)
})

test('a funded account reports what is actually spendable', () => {
  const view = balanceView({ native: '10000000000000000', tokens: [usdt('2500000000000000000')] })
  assert.equal(view.needsFunding, false)
  assert.equal(view.summary, 'Ready to spend: 2.5 USDT.')
  // The native row is present but never counted as spendable.
  assert.deepEqual(
    view.rows.map((row) => [row.symbol, row.spendable]),
    [
      ['BNB', false],
      ['USDT', true],
    ],
  )
})

test('a dust balance counts as funded rather than empty', () => {
  const view = balanceView({ native: '0', tokens: [usdt('1')] })
  assert.equal(view.needsFunding, false)
})

test('headlines never call a missing account an error', () => {
  assert.match(accountHeadline({ kind: 'none' }), /No account yet/)
  assert.match(accountHeadline({ kind: 'signed_out' }), /Sign in/)
  assert.match(accountHeadline({ kind: 'loading' }), /Reading/)
  assert.equal(accountHeadline({ kind: 'failed', message: 'API is down.' }), 'API is down.')
  assert.match(
    accountHeadline({
      kind: 'ready',
      address: '0x1',
      chainId: 56,
      network: 'mainnet',
      balances: null,
    }),
    /could not be read/,
  )
})

test('the explorer link follows the execution chain, and is absent when unknown', () => {
  assert.equal(explorerAccountUrl(56, '0xabc'), 'https://bscscan.com/address/0xabc')
  assert.equal(explorerAccountUrl(97, '0xabc'), 'https://testnet.bscscan.com/address/0xabc')
  assert.equal(explorerAccountUrl(1, '0xabc'), null)
})

test('the header line tells none, some and unreadable apart', () => {
  assert.equal(agentWalletLine(undefined), 'Agent wallet')
  assert.equal(agentWalletLine(null), 'Agent wallet: balance unreadable')
  assert.equal(
    agentWalletLine({ native: '9000000000000000000', tokens: [usdt('0')] }),
    'Agent wallet: nothing to spend',
  )
  assert.equal(agentWalletLine({ native: '0', tokens: [usdt('2500000000000000000')] }), '2.5 USDT')
})

test('the header never counts native BNB as something to spend', () => {
  // An account full of BNB has nothing an agent can move, and a header saying
  // otherwise would send somebody off to debug a mandate that is working.
  assert.match(
    agentWalletLine({ native: '100000000000000000000', tokens: [usdt('0')] }),
    /nothing to spend/,
  )
})
