import { expect, it } from 'vitest'
import { InMemoryCreditStore } from '../credits/store.js'
import { fundJob, InsufficientPoints, settleJob } from './ledger.js'

const BUYER = '0xbuyer000000000000000000000000000000000001'
const AGENT_OWNER = '0xagent000000000000000000000000000000000002'
const TREASURY = '0xtreasury0000000000000000000000000000000003'

const funded = async (points = 20_000) => {
  const credits = new InMemoryCreditStore()
  await credits.deposit({ owner: BUYER, points, reason: 'deposit', reference: 'seed' })
  return credits
}

it('moves money in three legs that add up', async () => {
  const credits = await funded()
  const total = 10_250 // 10,000 to the agent plus the 2.5% quoted fee

  await fundJob({ credits, jobId: 'j1', buyer: BUYER, totalPoints: total })
  expect(await credits.balance(BUYER)).toBe(20_000 - total)

  const legs = await settleJob({
    credits,
    jobId: 'j1',
    agentOwner: AGENT_OWNER,
    treasury: TREASURY,
    pricePoints: 10_000,
  })
  expect(legs.paidToAgent + legs.fee).toBe(total)
  expect(await credits.balance(AGENT_OWNER)).toBe(legs.paidToAgent)
  expect(await credits.balance(TREASURY)).toBe(legs.fee)
  // The fee AiKi keeps is the fee it quoted, not a second number.
  expect(legs.fee).toBe(250)
})

it('refuses a job the buyer cannot pay for, before taking anything', async () => {
  const credits = await funded(500)
  await expect(
    fundJob({ credits, jobId: 'j2', buyer: BUYER, totalPoints: 10_250 }),
  ).rejects.toBeInstanceOf(InsufficientPoints)
  /*
   * Nothing taken. Charging what is there and calling the rest a shortfall is
   * right for a model turn already spent and wrong for work not yet started: a
   * partly funded job is not a funded job.
   */
  expect(await credits.balance(BUYER)).toBe(500)
})

it('pays once however many times settlement is retried', async () => {
  const credits = await funded()
  await fundJob({ credits, jobId: 'j3', buyer: BUYER, totalPoints: 10_250 })
  const once = await settleJob({
    credits,
    jobId: 'j3',
    agentOwner: AGENT_OWNER,
    treasury: TREASURY,
    pricePoints: 10_000,
  })
  expect(once.alreadySettled).toBe(false)

  const twice = await settleJob({
    credits,
    jobId: 'j3',
    agentOwner: AGENT_OWNER,
    treasury: TREASURY,
    pricePoints: 10_000,
  })
  // A retry is not a mistake, and it is not a second payment either.
  expect(twice.alreadySettled).toBe(true)
  expect(await credits.balance(AGENT_OWNER)).toBe(once.paidToAgent)
  expect(await credits.balance(TREASURY)).toBe(once.fee)
})

it('keeps two jobs to the same agent separate', async () => {
  const credits = await funded(30_000)
  for (const jobId of ['j4', 'j5']) {
    await fundJob({ credits, jobId, buyer: BUYER, totalPoints: 10_250 })
    await settleJob({
      credits,
      jobId,
      agentOwner: AGENT_OWNER,
      treasury: TREASURY,
      pricePoints: 10_000,
    })
  }
  // Keyed on the job, so the second sale is a second payment.
  expect(await credits.balance(AGENT_OWNER)).toBe(20_000)
  expect(await credits.balance(TREASURY)).toBe(500)
})

/*
 * Proven on production before this guard existed: funding the same job twice
 * charged a buyer 2,050 points for a 1,025 point job, and both calls answered
 * 200. The route read a balance, judged it sufficient, and charged, and two
 * callers interleaved between the read and the write. A guard in the route
 * cannot close that; the unique index on `reference` can, because the second
 * writer loses in the database rather than in a comparison.
 */
it('charges once for a job however many times funding is called', async () => {
  const { DuplicateCharge } = await import('../credits/store.js')
  const credits = await funded(20_000)
  const args = { credits, jobId: 'once', buyer: BUYER, totalPoints: 10_250 }

  const first = await fundJob(args)
  expect(first.held).toBe(10_250)
  await expect(fundJob(args)).rejects.toBeInstanceOf(DuplicateCharge)
  expect(await credits.balance(BUYER)).toBe(20_000 - 10_250)
})

it('refuses rather than part-funding a job the balance cannot cover', async () => {
  const credits = await funded(10_000)
  await expect(
    fundJob({ credits, jobId: 'short', buyer: BUYER, totalPoints: 10_250 }),
  ).rejects.toBeInstanceOf(InsufficientPoints)
  /*
   * Nothing taken, and specifically not the 10,000 that was there. Taking what
   * is available and calling the rest a shortfall is right for a model turn
   * already spent; for work not yet started it is money taken for something
   * nobody bought.
   */
  expect(await credits.balance(BUYER)).toBe(10_000)
})

it('keeps funding separate per job', async () => {
  const credits = await funded(30_000)
  await fundJob({ credits, jobId: 'a', buyer: BUYER, totalPoints: 10_250 })
  await fundJob({ credits, jobId: 'b', buyer: BUYER, totalPoints: 10_250 })
  expect(await credits.balance(BUYER)).toBe(30_000 - 20_500)
})

/*
 * The books, checked as books.
 *
 * Funding used to debit the buyer and credit nobody, and settling used to
 * deposit to the seller out of nowhere. The two amounts matched, so the totals
 * looked right while the ledger balanced at no single moment, and a funded job
 * that was never settled held money that existed in no account at all.
 */
const sum = async (credits: InMemoryCreditStore, owners: string[]) => {
  let total = 0
  for (const o of owners) total += await credits.balance(o)
  return total
}

it('never lets money exist in no account', async () => {
  const { ESCROW_ACCOUNT } = await import('../credits/store.js')
  const credits = await funded(20_000)
  const everyone = [BUYER, AGENT_OWNER, TREASURY, ESCROW_ACCOUNT]
  expect(await sum(credits, everyone)).toBe(20_000)

  await fundJob({ credits, jobId: 'books', buyer: BUYER, totalPoints: 10_250 })
  // Held, and visibly held: the marketplace owes this to somebody.
  expect(await credits.balance(ESCROW_ACCOUNT)).toBe(10_250)
  expect(await sum(credits, everyone)).toBe(20_000)

  await settleJob({
    credits,
    jobId: 'books',
    agentOwner: AGENT_OWNER,
    treasury: TREASURY,
    pricePoints: 10_000,
  })
  expect(await credits.balance(ESCROW_ACCOUNT)).toBe(0)
  // Nothing minted and nothing burned, at any point in the sale.
  expect(await sum(credits, everyone)).toBe(20_000)
})

it('gives the money back when the work does not happen', async () => {
  const { ESCROW_ACCOUNT } = await import('../credits/store.js')
  const { refundJob } = await import('./ledger.js')
  const credits = await funded(20_000)

  await fundJob({ credits, jobId: 'gone', buyer: BUYER, totalPoints: 10_250 })
  const back = await refundJob({
    credits,
    jobId: 'gone',
    buyer: BUYER,
    totalPoints: 10_250,
    because: 'the agent never answered',
  })
  expect(back.refunded).toBe(10_250)
  expect(await credits.balance(BUYER)).toBe(20_000)
  expect(await credits.balance(ESCROW_ACCOUNT)).toBe(0)

  // A second attempt returns nothing and says so, rather than paying twice.
  const again = await refundJob({
    credits,
    jobId: 'gone',
    buyer: BUYER,
    totalPoints: 10_250,
    because: 'retry',
  })
  expect(again.alreadyRefunded).toBe(true)
  expect(await credits.balance(BUYER)).toBe(20_000)
})

it('cannot refund a job nobody funded', async () => {
  const { refundJob } = await import('./ledger.js')
  const { InsufficientBalance } = await import('../credits/store.js')
  const credits = await funded(20_000)
  /*
   * Refunds come out of escrow, so they can only return money that was taken
   * in. Paying a refund out of thin air is how a marketplace pays out more than
   * it ever held.
   */
  await expect(
    refundJob({ credits, jobId: 'never', buyer: BUYER, totalPoints: 10_250, because: 'test' }),
  ).rejects.toBeInstanceOf(InsufficientBalance)
  expect(await credits.balance(BUYER)).toBe(20_000)
})
