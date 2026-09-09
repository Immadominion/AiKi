import { expect, it } from 'vitest'
import { executorAddress, executorIdentity } from './executor-identity.js'

// Public fixture scalar, not a funded or configured project key.
const KEY = `0x${'00'.repeat(31)}01`
const ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'

it('derives the address actually controlled by the executor key', () => {
  expect(executorAddress(KEY)).toBe(ADDRESS)
  expect(executorIdentity({ AGENT_PRIVATE_KEY: KEY })).toEqual({
    agentKey: KEY,
    agentSessionKey: ADDRESS,
  })
})

it('accepts matching explicit executor addresses regardless of casing', () => {
  expect(
    executorIdentity({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ADDRESS: ADDRESS.toLowerCase() }),
  ).toEqual({
    agentKey: KEY,
    agentSessionKey: ADDRESS,
  })
})

it('preserves absent and address-only configurations without inventing an execution key', () => {
  expect(executorIdentity({})).toEqual({})
  expect(executorIdentity({ AGENT_PRIVATE_KEY: ' ', AGENT_SESSION_ADDRESS: ' ' })).toEqual({})
  expect(executorIdentity({ AGENT_SESSION_ADDRESS: ADDRESS })).toEqual({
    agentSessionKey: ADDRESS.toLowerCase(),
  })
})

it('rejects mismatched roles without printing either key or address', () => {
  const different = `0x${'22'.repeat(20)}`
  expect(() =>
    executorIdentity({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ADDRESS: different }),
  ).toThrow('does not match')
  try {
    executorIdentity({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ADDRESS: different })
  } catch (error) {
    expect(String(error)).not.toContain(KEY)
    expect(String(error)).not.toContain(different)
  }
})

it.each(['not-a-private-key', `0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`])(
  'refuses invalid private keys with a sanitized error',
  (key) => {
    expect(() => executorAddress(key)).toThrow('AGENT_PRIVATE_KEY is not a valid executor key.')
    try {
      executorAddress(key)
    } catch (error) {
      expect(String(error)).not.toContain(key)
    }
  },
)

it.each(['invalid-address', `0x${'00'.repeat(20)}`, '0x1234'])(
  'refuses invalid declared executor addresses',
  (address) => {
    expect(() => executorIdentity({ AGENT_SESSION_ADDRESS: address })).toThrow(
      'nonzero executor address',
    )
  },
)
