import assert from 'node:assert/strict'
import { test } from 'node:test'
import { briefText, identitySeed, safeAvatarUrl } from './identity'

test('wallet marks persist across case changes, reloads and other accounts', () => {
  const wallet = '0x16240f6655F5f9e0A4965A27f857e59c4922255A'
  const seed = identitySeed(wallet)
  assert.equal(seed, identitySeed(wallet.toLowerCase()))
  assert.equal(seed, identitySeed(` ${wallet} `))
  assert.notEqual(seed, identitySeed('0x76240f6655F5f9e0A4965A27f857e59c4922255A'))
  assert.equal(seed, identitySeed(wallet))
})
test('avatar artwork accepts HTTPS and IPFS, rejects executable and local URLs', () => {
  assert.equal(
    safeAvatarUrl('https://api.8004scan.io/api/v1/media/agents/56/43129/image'),
    'https://api.8004scan.io/api/v1/media/agents/56/43129/image',
  )
  assert.equal(
    safeAvatarUrl('ipfs://bafy-test/image.png'),
    'https://ipfs.io/ipfs/bafy-test/image.png',
  )
  for (const value of [
    'javascript:alert(1)',
    'data:image/svg+xml,<svg/>',
    '/private',
    '//evil.example/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://x.local/a',
    'https://user:pass@example.com/a',
    'http://example.com/a',
    'https://example.com:999/a',
    'https://2130706433/x',
  ])
    assert.equal(safeAvatarUrl(value), undefined, value)
})
test('compact previews preserve source text and never invent financial metrics', () => {
  const source = `Position for 0x16240f6655F5f9e0A4965A27f857e59c4922255A\u2014no borrow. ${'A long delivery. '.repeat(100)}`
  const preview = briefText(source, 140)
  assert.ok(preview.length <= 140)
  assert.ok(preview.includes('0x1624…255A'))
  assert.ok(preview.endsWith('…'))
  assert.ok(!preview.includes('\u2014'))
  assert.ok(source.includes('\u2014'))
  assert.equal(briefText('  Delivered\nthis  result. '), 'Delivered this result.')
})
