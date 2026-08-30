import type { SignedDelegation } from '@aiki/contracts'
import type { Address, Hex } from 'viem'
import type { Action } from '../authority/policy.js'
import { execute } from '../execution/executor.js'
import { ClientError } from '../http/errors.js'
import type { JobService } from './service.js'
import type { AuthorizationRecord } from './store.js'

/**
 * One action, through all three of the things that get to refuse it.
 *
 * This is the order the product is actually about. The agent decides something
 * should happen. The mandate decides whether it is permitted, off chain, where
 * the answer is fast and the reason is legible. Then the chain decides, which is
 * the only one of the three that cannot be talked out of it.
 *
 * All three answers are recorded, including the refusals. A receipt listing only
 * what succeeded is a brochure.
 */

export interface ActOutcome {
  /** What the off-chain policy engine said, and why. */
  policy: { allow: boolean; rule: string; reason: string }
  /** What the chain did, when it was asked. Absent when it never was. */
  chain?: {
    status: 'landed' | 'reverted'
    transactionHash: Hex
    revertReason?: string
  }
  /** Who ultimately held the limit for this action. */
  heldBy: 'chain' | 'aiki'
}

export interface ActConfig {
  rpcUrl: string
  chainId: number
  manager: Address
  /**
   * The agent's session key. It is the delegate, so it is the only address the
   * manager will accept a redemption from, and it pays its own gas. It holds no
   * authority of its own: everything it can do, it can do only inside a
   * delegation somebody signed.
   */
  agentKey: Hex
}

export async function act(input: {
  jobs: JobService
  jobId: string
  action: Action
  callData: Hex
  authorization: AuthorizationRecord
  config?: ActConfig
}): Promise<ActOutcome> {
  const { jobs, jobId, action, callData, authorization, config } = input

  /*
   * The off-chain gate first, because it is the one that can say no cheaply and
   * explain itself, and because charging the cap and checking it happen in one
   * locked step. Two concurrent actions must not both fit under a limit only one
   * of them fits under.
   */
  const policy = await jobs.attempt(jobId, action)
  if (!policy.allow) return { policy, heldBy: authorization.delegation ? 'chain' : 'aiki' }

  const delegation = authorization.delegation as SignedDelegation | undefined
  if (!delegation || !config) {
    // Nothing was signed, or this deployment cannot reach a chain. The action is
    // permitted and AiKi is the only thing that held the limit, which is a real
    // answer and has to be reported as itself.
    return { policy, heldBy: 'aiki' }
  }

  const outcome = await execute({
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    delegationManager: config.manager,
    relayerKey: config.agentKey,
    delegation: delegation as never,
    action,
    callData,
  })

  if (outcome.status === 'reverted') {
    /*
     * The chain refused what the off-chain engine allowed, and the cap was
     * already charged for it. Left alone, the counter would be ahead of reality
     * and every later action measured against money that never moved.
     *
     * This is also the case worth the whole product existing: the two engines
     * disagreed and the chain won.
     */
    await jobs.releaseSpend(authorization.id, action.amount)
    await jobs.record(jobId, {
      type: 'policy',
      detail: `chain refused: ${outcome.revertReason ?? 'reverted'}`,
    })
    return {
      policy,
      chain: {
        status: 'reverted',
        transactionHash: outcome.transactionHash,
        ...(outcome.revertReason ? { revertReason: outcome.revertReason } : {}),
      },
      heldBy: 'chain',
    }
  }

  await jobs.record(jobId, {
    type: 'status',
    detail: `landed on chain: ${outcome.transactionHash}`,
  })
  return {
    policy,
    chain: { status: 'landed', transactionHash: outcome.transactionHash },
    heldBy: 'chain',
  }
}

/** A caller may only ask for an action this mandate could conceivably permit. */
export function parseAction(body: {
  target?: string
  selector?: string
  asset?: string
  amount?: string
  callData?: string
}): { action: Action; callData: Hex } {
  const hex = (value: string | undefined, bytes: number, name: string) => {
    if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value))
      throw new ClientError(`${name} must be a 0x-prefixed ${bytes}-byte value.`, {
        code: 'ACTION_MALFORMED',
      })
    return value
  }
  // In the order somebody would read the fields, so a bad address is reported as
  // a bad address rather than as whatever the next check happens to trip on.
  const target = hex(body.target, 20, 'Target')
  const selector = hex(body.selector, 4, 'Selector')
  const asset = hex(body.asset, 20, 'Asset')

  let amount: bigint
  try {
    amount = BigInt(String(body.amount))
  } catch {
    throw new ClientError('Amount must be a whole number of base units.', {
      code: 'ACTION_MALFORMED',
    })
  }
  if (amount < 0n) throw new ClientError('Amount cannot be negative.', { code: 'ACTION_MALFORMED' })
  if (typeof body.callData !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body.callData))
    throw new ClientError('Call data must be 0x-prefixed hex.', { code: 'ACTION_MALFORMED' })

  return {
    action: { target, selector, asset, amount, at: new Date().toISOString() },
    callData: body.callData as Hex,
  }
}
