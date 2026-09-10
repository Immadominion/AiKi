import { expect, it, vi } from 'vitest'
import { type CreditStore, ESCROW_ACCOUNT, InMemoryCreditStore } from '../credits/store.js'
import { fundJob, settleJob } from './ledger.js'

const BUYER = `0x${'11'.repeat(20)}`,
  SELLER = `0x${'22'.repeat(20)}`,
  TREASURY = `0x${'33'.repeat(20)}`,
  OTHER = `0x${'44'.repeat(20)}`
async function fixture() {
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: BUYER, points: 102, reason: 'test', reference: 'seed' })
  await fundJob({ credits, jobId: 'test', buyer: BUYER, totalPoints: 102 })
  const input = { credits, jobId: 'test', agentOwner: SELLER, treasury: TREASURY, pricePoints: 100 }
  return { credits, input }
}

it('confirms an exact completed settlement with zero escrow without another transfer', async () => {
  const { credits, input } = await fixture()
  await settleJob(input)
  const transfer = vi.spyOn(credits, 'transfer')
  expect((await settleJob(input)).alreadySettled).toBe(true)
  expect(transfer).not.toHaveBeenCalled()
  expect(await credits.balance(ESCROW_ACCOUNT)).toBe(0)
  expect(await credits.balance(SELLER)).toBe(100)
  expect(await credits.balance(TREASURY)).toBe(2)
})

it('recovers a committed seller transfer whose response was lost and then pays only the fee', async () => {
  const { credits, input } = await fixture(),
    real = credits.transfer.bind(credits)
  const transfer = vi.spyOn(credits, 'transfer').mockImplementationOnce(async (args) => {
    await real(args)
    throw new Error('lost acknowledgement')
  })
  expect((await settleJob(input)).alreadySettled).toBe(true)
  expect(transfer).toHaveBeenCalledTimes(2)
  expect(await credits.balance(SELLER)).toBe(100)
  expect(await credits.balance(TREASURY)).toBe(2)
  expect(await credits.balance(ESCROW_ACCOUNT)).toBe(0)
})

it.each(['recipient', 'amount', 'reason'] as const)(
  'does not mistake a duplicate with wrong %s for a paid leg',
  async (bad) => {
    const { credits, input } = await fixture()
    await credits.transfer({
      from: ESCROW_ACCOUNT,
      to: bad === 'recipient' ? OTHER : SELLER,
      points: bad === 'amount' ? 99 : 100,
      reason: bad === 'reason' ? 'other' : 'job_earnings',
      reference: 'job:test:job_earnings',
    })
    await expect(settleJob(input)).rejects.toThrow()
    expect(await credits.balance(TREASURY)).toBe(0)
  },
)

it('does not send a transfer when exact prior-ledger readback is unavailable', async () => {
  const { credits, input } = await fixture(),
    transfer = vi.spyOn(credits, 'transfer')
  vi.spyOn(credits, 'transferRecorded').mockRejectedValue(new Error('database unavailable'))
  await expect(settleJob(input)).rejects.toThrow('database unavailable')
  expect(transfer).not.toHaveBeenCalled()
  expect(await credits.balance(ESCROW_ACCOUNT)).toBe(102)
})

it('does not confirm an ambiguous transfer when subsequent evidence is unavailable', async () => {
  const { credits, input } = await fixture()
  vi.spyOn(credits, 'transfer').mockRejectedValue(new Error('unknown transfer outcome'))
  vi.spyOn(credits, 'transferRecorded')
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('readback unavailable'))
  await expect(settleJob(input)).rejects.toThrow('readback unavailable')
  expect(await credits.balance(TREASURY)).toBe(0)
})

it('fails closed if an injected ledger has no exact-pair verification capability', async () => {
  const { credits, input } = await fixture(),
    transfer = vi.spyOn(credits, 'transfer')
  const missing = new Proxy(credits, {
    get(target, name, receiver) {
      return name === 'transferRecorded' ? undefined : Reflect.get(target, name, receiver)
    },
  }) as CreditStore
  await expect(settleJob({ ...input, credits: missing })).rejects.toThrow('readback is unavailable')
  expect(transfer).not.toHaveBeenCalled()
})
