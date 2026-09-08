import { createPublicClient, http } from 'viem'
import { bscTestnet } from 'viem/chains'
import type { DepositConfig } from './deposit.js'
import { pointsForUsdt } from './pricing.js'

/**
 * What the treasury holds, in the same unit the ledger counts in.
 *
 * The other half of the solvency question. The ledger knows what AiKi owes; only
 * the chain knows what AiKi has, and comparing the two is the difference between
 * "the books balance" and "there is money behind them". A marketplace can have a
 * perfectly consistent ledger and no funds at all.
 *
 * Returns null rather than throwing or guessing. A treasury that cannot be read
 * is an unverified claim, and the check that consumes this reports it as one,
 * because an unverified solvency claim and a verified one must not look alike.
 */
export async function treasuryBackingPoints(
  config: DepositConfig | undefined,
): Promise<number | null> {
  if (!config) return null
  try {
    const client = createPublicClient({ chain: bscTestnet, transport: http(config.rpcUrl) })
    const held = await client.readContract({
      address: config.token,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'balanceOf',
      args: [config.treasury],
    })
    // Through the same conversion a deposit uses, so what a payment bought and
    // what it is worth here cannot disagree.
    return pointsForUsdt(held)
  } catch {
    return null
  }
}
