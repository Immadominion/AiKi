import { expect, it } from 'vitest'
import { apiIsSameSite, describeCookieMismatch, SessionSigner } from './session.js'

it('accepts a matching domain and origin, and explains a mismatch', () => {
  expect(describeCookieMismatch('useaiki.xyz', 'https://useaiki.xyz')).toBeNull()
  expect(describeCookieMismatch('localhost:4747', 'http://localhost:4747')).toBeNull()
  expect(describeCookieMismatch('useaiki.xyz', 'https://app.useaiki.xyz')).toContain('AUTH_DOMAIN')
  expect(describeCookieMismatch('useaiki.xyz', 'not a url')).toContain('not a valid URL')
})

it('knows when the API cannot receive the app session cookie', () => {
  expect(apiIsSameSite('api.useaiki.xyz', 'https://useaiki.xyz')).toBe(true)
  expect(apiIsSameSite('useaiki.xyz', 'https://useaiki.xyz')).toBe(true)
  // The exact mistake a Railway subdomain would produce.
  expect(apiIsSameSite('aiki-api.up.railway.app', 'https://useaiki.xyz')).toBe(false)
  // And the one that cost me a confusing minute: these are different sites.
  expect(apiIsSameSite('127.0.0.1', 'http://localhost:4747')).toBe(false)
})

it('refuses a session token signed with another secret', () => {
  const token = new SessionSigner('a'.repeat(40)).issue('0xabc', 56)
  expect(new SessionSigner('b'.repeat(40)).verify(token)).toBeNull()
  expect(new SessionSigner('a'.repeat(40)).verify(token)?.address).toBe('0xabc')
})
