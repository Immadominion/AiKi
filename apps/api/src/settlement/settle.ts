import type { Address, Hex } from 'viem'
import type { Action } from '../authority/policy.js'
import { type ExecutionRequest, erc20TransferCall, execute } from '../execution/executor.js'
import { type Priced, priceJob } from './pricing.js'

/**
 * Paying for a job.
 *
 * A settlement is two transfers, not one: the agent is paid its price and AiKi
 * is paid its fee, from the same mandate, under the same caps. They are separate
 * redemptions on purpose. A single transfer to a splitter contract would mean
 * the user authorised a payment to something that then decides where the money
 * goes, and the caveats could no longer say who was paid. Two transfers to two
 * named addresses are two facts the enforcers can each check.
 *
 * The consequence is that a settlement can be half-done: the price lands and the
 * fee is refused by a cap. That is reported as such rather than retried or
 * hidden, because the agent HAS been paid and pretending otherwise would be the
 * more expensive lie.
 */
export interface SettlementRequest {
  chain: Omit<ExecutionRequest, 'delegation' | 'action' | 'callData'>
  delegation: ExecutionRequest['delegation']
  asset: Address
  /** Where the agent is paid. */
  payee: Address
  /** Where the platform fee is paid. */
  treasury: Address
  price: bigint
  at?: string
}

export interface SettlementOutcome {
  priced: Priced
  pricePaid: boolean
  feePaid: boolean
  /** True only when both legs landed. */
  settled: boolean
  /**
   * One row per leg attempted. `transactionHash` is absent when the node would
   * not accept the transaction at all: there is nothing on chain to cite, and a
   * settlement record naming a transaction that never existed is worse than one
   * that admits nothing was sent.
   */
  transactions: { leg: 'price' | 'fee'; status: string; transactionHash?: Hex }[]
  detail: string
}

export async function settle(request: SettlementRequest): Promise<SettlementOutcome> {
  const priced = priceJob(request.price)
  const at = request.at ?? new Date().toISOString()
  const transactions: SettlementOutcome['transactions'] = []

  const leg = async (name: 'price' | 'fee', to: Address, amount: bigint) => {
    if (amount === 0n) return true
    const action: Action = {
      target: request.asset,
      selector: '0xa9059cbb',
      asset: request.asset,
      amount,
      at,
    }
    const outcome = await execute({
      ...request.chain,
      delegation: request.delegation,
      action,
      callData: erc20TransferCall(to, amount),
    })
    transactions.push({
      leg: name,
      status: outcome.status,
      // Absent for a leg the node would not accept: there is no transaction to
      // cite, and a receipt naming one would be citing nothing.
      ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
    })
    return outcome.status === 'landed'
  }

  const pricePaid = await leg('price', request.payee, priced.price)
  // The fee is only attempted once the agent has actually been paid. Taking a
  // platform fee for work that was never settled would be the worst possible
  // ordering.
  const feePaid = pricePaid ? await leg('fee', request.treasury, priced.platformFee) : false

  return {
    priced,
    pricePaid,
    feePaid,
    settled: pricePaid && feePaid,
    transactions,
    detail: pricePaid
      ? feePaid
        ? 'Agent paid and platform fee taken.'
        : 'Agent was paid, but the platform fee was refused. The job is settled from the agent side and AiKi is unpaid.'
      : 'Nothing was paid; the mandate refused the agent payment.',
  }
}
