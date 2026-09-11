import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimPendingFastAsk,
  parsePendingFastAsk,
  serializePendingFastAsk,
} from './fast-pending-ask'

const A = '0x16240f6655F5f9e0A4965A27f857e59c4922255A'
const B = '0x1111111111111111111111111111111111111111'

test('an anonymous Fast draft attaches to the wallet selected for its handoff', () => {
  const draft = parsePendingFastAsk('Protect my Venus position')
  assert.ok(draft)
  assert.deepEqual(claimPendingFastAsk(draft, A), {
    text: 'Protect my Venus position',
    owner: A.toLowerCase(),
  })
})

test('a wallet-scoped Fast draft cannot appear for another wallet', () => {
  const stored = serializePendingFastAsk({ text: 'Private position details', owner: A })
  const draft = parsePendingFastAsk(stored)
  assert.ok(draft)
  assert.equal(claimPendingFastAsk(draft, B), null)
  assert.equal(claimPendingFastAsk(draft, null), null)
  assert.equal(claimPendingFastAsk(draft, A.toUpperCase())?.text, 'Private position details')
})

test('empty values are ignored and the earlier plain-text shape stays readable', () => {
  assert.equal(parsePendingFastAsk(null), null)
  assert.equal(parsePendingFastAsk('   '), null)
  assert.deepEqual(parsePendingFastAsk('{not-json'), { text: '{not-json', owner: null })
})
