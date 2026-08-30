import {
  type Address,
  createPublicClient,
  type Hex,
  http,
  parseAbiItem,
  toEventSelector,
} from 'viem'
import { bscTestnet } from 'viem/chains'
import { ClientError } from '../http/errors.js'
import { pointsForUsdt } from './pricing.js'
import type { CreditStore } from './store.js'

/**
 * Turning a payment into points, without taking anybody's word for it.
 *
 * A caller hands over a transaction hash. Everything that decides how many
 * points they get is then read from the chain: the receipt, the Transfer log
 * inside it, who sent it, who received it, and how much. Nothing in the request
 * is trusted except which transaction to look at, because a caller who supplies
 * both the payment and its amount is not making a payment.
 *
 * Four things are checked, and each one is a way this would otherwise be free
 * money:
 *
 *   the transaction succeeded    — a reverted transfer moved nothing
 *   the token is the one we take — any ERC-20 can emit a Transfer event
 *   the recipient is the treasury— otherwise a payment to anyone counts
 *   the sender is the depositor  — otherwise somebody else's payment counts
 *
 * The hash is then the ledger's reference, and a unique index makes crediting
 * the same payment twice a constraint violation rather than a doubling.
 */

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
/** Computed rather than pasted, so it cannot be subtly wrong. */
const TRANSFER_TOPIC = toEventSelector(TRANSFER)

export interface DepositConfig {
  rpcUrl: string
  chainId: number
  /** The only token accepted, and the only address it may be sent to. */
  token: Address
  treasury: Address
}

export async function creditDeposit(input: {
  credits: CreditStore
  config: DepositConfig
  owner: string
  transactionHash: string
}): Promise<{ points: number; balance: number; amount: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash))
    throw new ClientError('That is not a transaction hash.', { code: 'DEPOSIT_MALFORMED' })

  const client = createPublicClient({ chain: bscTestnet, transport: http(input.config.rpcUrl) })

  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>
  try {
    receipt = await client.getTransactionReceipt({ hash: input.transactionHash as Hex })
  } catch {
    throw new ClientError(
      'No such transaction on this chain yet. If you have just sent it, wait for it to be mined and try again.',
      { code: 'DEPOSIT_NOT_FOUND', statusCode: 404 },
    )
  }
  if (receipt.status !== 'success')
    throw new ClientError('That transaction failed, so nothing was paid.', {
      code: 'DEPOSIT_REVERTED',
    })

  const wanted = {
    token: input.config.token.toLowerCase(),
    treasury: input.config.treasury.toLowerCase(),
    owner: input.owner.toLowerCase(),
  }

  /*
   * Every matching transfer in the transaction, summed. A payment split across
   * two transfers in one transaction is still that payment, and taking only the
   * first would quietly under-credit somebody.
   */
  let total = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wanted.token) continue
    // Topic 0 identifies the event; a Transfer always carries three topics,
    // since both address arguments are indexed.
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue
    try {
      const from = `0x${log.topics[1]?.slice(26)}`.toLowerCase()
      const to = `0x${log.topics[2]?.slice(26)}`.toLowerCase()
      if (to !== wanted.treasury) continue
      if (from !== wanted.owner) continue
      total += BigInt(log.data)
    } catch {
      // A log that does not decode is not a payment. Skipping it is right; the
      // alternative is refusing a legitimate deposit because something else in
      // the same transaction was unusual.
    }
  }

  if (total === 0n)
    throw new ClientError(
      `That transaction does not contain a payment from ${input.owner} to AiKi's treasury in the accepted token.`,
      { code: 'DEPOSIT_NOT_YOURS' },
    )

  const points = pointsForUsdt(total)
  if (points <= 0)
    throw new ClientError('That payment is too small to be worth any points.', {
      code: 'DEPOSIT_TOO_SMALL',
    })

  const balance = await input.credits.deposit({
    owner: input.owner,
    points,
    reason: 'deposit',
    reference: input.transactionHash.toLowerCase(),
    detail: {
      chainId: input.config.chainId,
      token: input.config.token,
      baseUnits: total.toString(),
      blockNumber: receipt.blockNumber.toString(),
    },
  })

  return { points, balance, amount: `${Number(total) / 1e6} USDT` }
}
