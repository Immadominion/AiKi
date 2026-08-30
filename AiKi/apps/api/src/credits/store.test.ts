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
