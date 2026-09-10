import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import {
  type ReviewedWalletTransaction,
  selectWallet,
  sendWalletTransaction,
  WalletTransactionError,
} from './wallet'
import { acceptWalletSession, invalidateWalletSession, walletSession } from './wallet-session'

const a = `0x${'11'.repeat(20)}`,
  b = `0x${'22'.repeat(20)}`,
  hash = `0x${'ab'.repeat(32)}`
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
afterEach(() => invalidateWalletSession())
after(() => {
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})
const tx: ReviewedWalletTransaction = {
  chainId: 56,
  from: a,
  to: b,
  data: '0x12345678',
  value: '0',
}
function fixture() {
  const calls: { method: string; params?: unknown[] }[] = []
  const state = { address: a, chain: '0x38', send: async (): Promise<unknown> => hash }
  acceptWalletSession(a, walletSession().revision)
  selectWallet({
    uuid: 'strategy',
    name: 'Test',
    rdns: 'test.strategy',
    icon: '',
    provider: {
      request: async (input) => {
        calls.push(input)
        if (input.method === 'eth_accounts') return [state.address]
        if (input.method === 'eth_chainId') return state.chain
        return state.send()
      },
    },
  })
  return { state, calls }
}
test('sends exactly one zero-value mainnet call through the selected provider', async () => {
  const f = fixture()
  assert.deepEqual(await sendWalletTransaction(a, tx), {
    transactionHash: hash,
    walletCurrent: true,
  })
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'eth_sendTransaction'),
    [
      {
        method: 'eth_sendTransaction',
        params: [{ from: a, to: b, data: tx.data, value: '0x0', chainId: '0x38' }],
      },
    ],
  )
})
test('rejects other chains, owners, native transfers and malformed calls before wallet submission', async () => {
  for (const changed of [
    { chainId: 97 },
    { from: b },
    { value: '1' },
    { data: '0x' },
    { to: '0x0' },
    { nonce: 1 },
  ]) {
    const f = fixture()
    await assert.rejects(
      sendWalletTransaction(a, { ...tx, ...changed } as ReviewedWalletTransaction),
      (error: unknown) => error instanceof WalletTransactionError && !error.mayHaveSubmitted,
    )
    assert.equal(f.calls.length, 0)
  }
})
test('checks actual wallet chain/account and authenticated revision before requesting a transaction', async () => {
  for (const change of ['chain', 'account', 'session']) {
    const f = fixture()
    if (change === 'chain') f.state.chain = '0x61'
    if (change === 'account') f.state.address = b
    if (change === 'session') invalidateWalletSession()
    await assert.rejects(
      sendWalletTransaction(a, tx),
      (error: unknown) =>
        error instanceof WalletTransactionError &&
        error.code === 'WALLET_CHANGED' &&
        !error.mayHaveSubmitted,
    )
    assert.ok(!f.calls.some((c) => c.method === 'eth_sendTransaction'))
  }
})
test('preserves rejection code 4001, but marks lost acknowledgement as uncertain', async () => {
  const f = fixture()
  f.state.send = async () => {
    throw { code: 4001 }
  }
  await assert.rejects(
    sendWalletTransaction(a, tx),
    (error: unknown) =>
      error instanceof WalletTransactionError && error.code === 4001 && !error.mayHaveSubmitted,
  )
  f.state.send = async () => {
    throw new Error('private provider information')
  }
  await assert.rejects(
    sendWalletTransaction(a, tx),
    (error: unknown) =>
      error instanceof WalletTransactionError &&
      error.mayHaveSubmitted &&
      !error.message.includes('private'),
  )
})
test('retains exact hash after wallet/session changes during confirmation without resending', async () => {
  const f = fixture()
  f.state.send = async () => {
    f.state.address = b
    invalidateWalletSession()
    return hash
  }
  assert.deepEqual(await sendWalletTransaction(a, tx), {
    transactionHash: hash,
    walletCurrent: false,
  })
  assert.equal(f.calls.filter((c) => c.method === 'eth_sendTransaction').length, 1)
})
