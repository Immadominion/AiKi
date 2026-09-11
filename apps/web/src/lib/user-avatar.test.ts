import assert from 'node:assert/strict'
import { test } from 'node:test'
import { userAvatarTraits } from './user-avatar'

const WALLET = '0x16240f6655F5f9e0A4965A27f857e59c4922255A'

test('a wallet keeps the same illustrated character across case and whitespace changes', () => {
  const expected = userAvatarTraits(WALLET)
  assert.deepEqual(userAvatarTraits(WALLET.toLowerCase()), expected)
  assert.deepEqual(userAvatarTraits(` ${WALLET} `), expected)
  assert.deepEqual(userAvatarTraits(WALLET), expected)
})

test('different wallets receive visibly different character traits', () => {
  const first = userAvatarTraits(WALLET)
  const second = userAvatarTraits('0x76240f6655F5f9e0A4965A27f857e59c4922255A')
  const changed = (Object.keys(first) as (keyof typeof first)[]).filter(
    (key) => first[key] !== second[key],
  )
  assert.ok(changed.length >= 4)
})

test('an empty identity has a stable private fallback', () => {
  assert.deepEqual(userAvatarTraits(''), userAvatarTraits('   '))
})
