import type { CreditStore } from '../credits/store.js'
import {
  DuplicateCharge,
  DuplicateDeposit,
  ESCROW_ACCOUNT,
  InsufficientBalance,
} from '../credits/store.js'
import { priceJob } from './pricing.js'

/**
 * Money actually moving for a job.
 *
 * The marketplace could quote and it could run an agent, and between those two
 * nothing ever changed hands: `settle()` in this directory was imported by no
 * file, and of the twelve job states the contract defines, FUNDED and SETTLED
 * were reached by no code path. A venue that can show you a price and hand you
 * the goods but cannot take payment is a catalogue, not a marketplace.
 *
 * This settles in points rather than on chain. Points are a real append-only
 * ledger with a real balance a person bought, not a scoreboard, so the three
 * legs of a sale are three rows anybody can add up: the buyer is charged, the
 * agent's owner is paid, and AiKi keeps the fee it quoted. Doing it on chain is
 * the next move and does not change the shape.
 *
 * Every leg is keyed on the job, so a retry cannot pay twice.
 */

export interface SettlementLegs {
  /** Taken from the buyer when the job is funded. */
  held: number
  /** What the agent's owner receives. */
  paidToAgent: number
  /** What AiKi keeps. Always quoted before it is taken. */
  fee: number
  buyerBalance: number
}

export class InsufficientPoints extends Error {
  constructor(
    readonly needed: number,
    readonly held: number,
  ) {
    super(`This job costs ${needed} points and the balance is ${held}.`)
    this.name = 'InsufficientPoints'
  }
}

/** The buyer pays. Nothing reaches the agent until the work is accepted. */
export async function fundJob(input: {
  credits: CreditStore
  jobId: string
  buyer: string
  /** Total in points, which is price plus the fee, as quoted. */
  totalPoints: number
}): Promise<{ held: number; buyerBalance: number }> {
  /*
   * Both guarantees are the store's, taken under its row lock, not this
   * function's taken hopefully beforehand.
   *
   * `exact` refuses rather than part-funding, because a partly funded job is
   * money taken for work nobody bought. `reference` makes the charge happen at
   * most once for this job, which is the thing a check-then-act cannot do:
   * funding the same job twice charged a buyer 2,050 points for a 1,025 point
   * job in production, both calls answering 200, because the balance was read
   * outside the transaction that spent it.
   */
  try {
    const moved = await input.credits.transfer({
      from: input.buyer,
      to: ESCROW_ACCOUNT,
      points: input.totalPoints,
      reason: 'job_funding',
      reference: `job:${input.jobId}:funding`,
      detail: { jobId: input.jobId },
    })
    return { held: moved.moved, buyerBalance: moved.fromBalance }
  } catch (error) {
    if (error instanceof InsufficientBalance) throw new InsufficientPoints(error.needed, error.held)
    throw error
  }
}

/**
 * The work was accepted, so the money moves on.
 *
 * `reference` is derived from the job for both legs, and `deposit` refuses a
 * reference it has already credited, so settling the same job twice pays
 * nobody twice. A duplicate is treated as already settled rather than as an
 * error, because the caller's retry is not a mistake.
 */
export async function settleJob(input: {
  credits: CreditStore
  jobId: string
  /** Where the agent's earnings go: the owner recorded on its passport. */
  agentOwner: string
  /** Where AiKi's fee goes. */
  treasury: string
  /**
   * The agent's price IN POINTS, not the total.
   *
   * Taking the total and dividing back out by the fee rate is how the sale and
   * the invoice start to disagree: the division does not land on an integer,
   * and the rounding is a second opinion about a number that was already
   * settled when the job was quoted. The fee is derived here from the same
   * `priceJob` the quote used, from the same input.
   */
  pricePoints: number
}): Promise<SettlementLegs & { alreadySettled: boolean }> {
  const priced = priceJob(BigInt(Math.max(0, Math.trunc(input.pricePoints))))
  const fee = Number(priced.platformFee)
  const toAgent = Number(priced.price)

  /*
   * Paid OUT OF ESCROW, not minted.
   *
   * These were deposits, so settling created points that had never been taken
   * from anybody: the buyer's funding debited them and credited nobody, and
   * settlement credited a seller from nowhere. The two happened to be equal, so
   * the totals looked right while the ledger did not balance at any single
   * moment and a funded-but-unsettled job's money existed in no account at all.
   */
  let alreadySettled = false
  const pay = async (owner: string, points: number, reason: string) => {
    if (points <= 0) return
    try {
      await input.credits.transfer({
        from: ESCROW_ACCOUNT,
        to: owner,
        points,
        reason,
        reference: `job:${input.jobId}:${reason}`,
        detail: { jobId: input.jobId },
      })
    } catch (error) {
      if (error instanceof DuplicateCharge || error instanceof DuplicateDeposit) {
        alreadySettled = true
        return
      }
      throw error
    }
  }

  await pay(input.agentOwner, toAgent, 'job_earnings')
  await pay(input.treasury, fee, 'platform_fee')

  return {
    held: Number(priced.total),
    paidToAgent: toAgent,
    fee,
    buyerBalance: await input.credits.balance(input.agentOwner),
    alreadySettled,
  }
}

/**
 * The money goes back.
 *
 * A payment system where money moves one way is not one. A job can be funded
 * and then the agent fails, is revoked, is found to be a static page, or simply
 * never runs, and until this existed the buyer's money stayed in escrow with no
 * route out of it.
 *
 * Refunding is the same movement as settling, in the other direction and out of
 * the same account, so it cannot pay out money that was never taken in. It is
 * keyed on the job like every other leg, so it happens once.
 */
export async function refundJob(input: {
  credits: CreditStore
  jobId: string
  buyer: string
  totalPoints: number
  /** Recorded on the entry, because a refund with no stated reason is an anomaly. */
  because: string
}): Promise<{ refunded: number; buyerBalance: number; alreadyRefunded: boolean }> {
  try {
    const moved = await input.credits.transfer({
      from: ESCROW_ACCOUNT,
      to: input.buyer,
      points: input.totalPoints,
      reason: 'job_refund',
      reference: `job:${input.jobId}:refund`,
      detail: { jobId: input.jobId, because: input.because },
    })
    return { refunded: moved.moved, buyerBalance: moved.toBalance, alreadyRefunded: false }
  } catch (error) {
    if (error instanceof DuplicateCharge)
      return {
        refunded: 0,
        buyerBalance: await input.credits.balance(input.buyer),
        alreadyRefunded: true,
      }
    throw error
  }
}
