import { expect, it } from 'vitest'
import { DuplicateDeposit, InMemoryCreditStore } from './store.js'

const OWNER = `0x${'ab'.repeat(20)}`

it('credits a payment once and refuses the same one twice', async () => {
  // The unique reference is what stands between a retried request and free
  // money: a timeout on the client must not mint points.
  const credits = new InMemoryCreditStore()
  expect(
    await credits.deposit({ owner: OWNER, points: 10_000, reason: 'deposit', reference: '0xtx' }),
  ).toBe(10_000)
  await expect(
    credits.deposit({ owner: OWNER, points: 10_000, reason: 'deposit', reference: '0xtx' }),
  ).rejects.toBeInstanceOf(DuplicateDeposit)
  expect(await credits.balance(OWNER)).toBe(10_000)
})

it('never lets a balance go negative', async () => {
  // A model can overrun an estimate. The honest answer is to take what is there
  // and record the shortfall, not to invent a debt nobody agreed to.
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 100, reason: 'deposit', reference: '0xa' })
  const out = await credits.charge({ owner: OWNER, points: 250, reason: 'fast_mode' })
  expect(out.charged).toBe(100)
  expect(out.balance).toBe(0)
  expect(out.shortfall).toBe(150)
  expect(await credits.balance(OWNER)).toBe(0)
})

it('treats an address as one person however it is cased', async () => {
  const credits = new InMemoryCreditStore()
  await credits.deposit({
    owner: OWNER.toUpperCase(),
    points: 500,
    reason: 'deposit',
    reference: '0xb',
  })
  expect(await credits.balance(OWNER.toLowerCase())).toBe(500)
})

it('keeps a balance equal to the sum of its entries', async () => {
  // The ledger is the truth and the balance is a cache of it. A balance that
  // cannot be re-derived is one nobody should trust.
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 1_000, reason: 'deposit', reference: '0xc' })
  await credits.charge({ owner: OWNER, points: 140, reason: 'fast_mode' })
  await credits.charge({ owner: OWNER, points: 60, reason: 'fast_mode' })
  const entries = await credits.history(OWNER)
  expect(entries.reduce((total, e) => total + e.delta, 0)).toBe(await credits.balance(OWNER))
  expect(await credits.balance(OWNER)).toBe(800)
})

it('records why every point moved', async () => {
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: OWNER, points: 1_000, reason: 'deposit', reference: '0xd' })
  await credits.charge({
    owner: OWNER,
    points: 140,
    reason: 'fast_mode',
    detail: { model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 200 },
  })
  const [latest] = await credits.history(OWNER)
  expect(latest?.reason).toBe('fast_mode')
  expect(latest?.detail.model).toBe('claude-sonnet-5')
})

it('charges nothing when there is nothing to charge', async () => {
  const credits = new InMemoryCreditStore()
  const out = await credits.charge({ owner: OWNER, points: 50, reason: 'fast_mode' })
  expect(out.charged).toBe(0)
  expect(out.shortfall).toBe(50)
  expect(await credits.history(OWNER)).toHaveLength(0)
})

/*
 * The welcome grant has one job and one hazard: a new account must be able to
 * try Fast mode without paying, and no account may collect the grant twice.
 * Both live in the reference, so both are tested through the store rather than
 * through the route that calls it.
 */
it('grants a new account its welcome points exactly once', async () => {
  const { InMemoryCreditStore } = await import('./store.js')
  const { WELCOME_GRANT_POINTS } = await import('./pricing.js')
  const store = new InMemoryCreditStore()
  const owner = '0xABCdef0000000000000000000000000000000001'
  const grant = () =>
    store.deposit({
      owner,
      points: WELCOME_GRANT_POINTS,
      reason: 'welcome',
      reference: `welcome:${owner.toLowerCase()}`,
    })

  expect(await grant()).toBe(WELCOME_GRANT_POINTS)
  // A refresh, a retry, a second tab: all the same reference, all refused.
  await expect(grant()).rejects.toThrow()
  // Case must not be a way around it, since an address is the same address.
  await expect(
    store.deposit({
      owner: owner.toLowerCase(),
      points: WELCOME_GRANT_POINTS,
      reason: 'welcome',
      reference: `welcome:${owner.toLowerCase()}`,
    }),
  ).rejects.toThrow()
  expect(await store.balance(owner)).toBe(WELCOME_GRANT_POINTS)
})

it('gives enough to actually ask something', async () => {
  const { WELCOME_GRANT_POINTS, MINIMUM_BALANCE_POINTS } = await import('./pricing.js')
  // A grant below the floor to ask would be a grant that does nothing.
  expect(WELCOME_GRANT_POINTS).toBeGreaterThan(MINIMUM_BALANCE_POINTS)
})
