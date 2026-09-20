import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AWAY_BEFORE_NEW_MS,
  chatToResume,
  parseRememberedChat,
  serializeRememberedChat,
} from './fast-session'

const id = '11111111-1111-4111-8111-111111111111'
const owner = '0xAbCdEf0000000000000000000000000000000001'
const now = 1_760_000_000_000

test('comes back to the conversation you stepped away from', () => {
  const stored = serializeRememberedChat({ id, owner, at: now - 60_000 })
  assert.equal(chatToResume(parseRememberedChat(stored), owner, now), id)
  // The address is the same account whatever case the wallet reports it in.
  assert.equal(chatToResume(parseRememberedChat(stored), owner.toLowerCase(), now), id)
})

test('starts fresh after a long enough absence, and never for another wallet', () => {
  const old = parseRememberedChat(
    serializeRememberedChat({ id, owner, at: now - AWAY_BEFORE_NEW_MS - 1 }),
  )
  assert.equal(chatToResume(old, owner, now), null)

  const justInside = parseRememberedChat(
    serializeRememberedChat({ id, owner, at: now - AWAY_BEFORE_NEW_MS + 1 }),
  )
  assert.equal(chatToResume(justInside, owner, now), id)

  const someoneElse = parseRememberedChat(serializeRememberedChat({ id, owner, at: now }))
  assert.equal(chatToResume(someoneElse, '0x0000000000000000000000000000000000000002', now), null)
  assert.equal(chatToResume(someoneElse, null, now), null)
})

test('a clock that moved backwards does not pin a thread open', () => {
  const future = parseRememberedChat(serializeRememberedChat({ id, owner, at: now + 60_000 }))
  assert.equal(chatToResume(future, owner, now), null)
})

test('refuses anything that is not a conversation this app wrote', () => {
  assert.equal(parseRememberedChat(null), null)
  assert.equal(parseRememberedChat('not json'), null)
  assert.equal(parseRememberedChat('{}'), null)
  assert.equal(parseRememberedChat(JSON.stringify({ id: 'nope', owner, at: now })), null)
  assert.equal(parseRememberedChat(JSON.stringify({ id, owner: '', at: now })), null)
  assert.equal(parseRememberedChat(JSON.stringify({ id, owner, at: 'soon' })), null)
})
