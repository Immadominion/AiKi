import type { SignedDelegation } from '@aiki/contracts'
import type { Address, Hex } from 'viem'
import { recipientOf, selectorOf } from '../authority/calldata.js'
import type { Action } from '../authority/policy.js'
import { executeJobAction } from '../execution/job-execution.js'
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
  /**
   * What the chain did, when it was asked. Absent when it never was.
   *
   * `refused` carries no hash on purpose: the node would not take the
   * transaction, so nothing was submitted, nothing was spent, and there is
   * nothing to link to.
   */
  chain?: {
    status: 'landed' | 'reverted' | 'refused' | 'unconfirmed'
    transactionHash?: Hex
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
  /**
   * Why the agent wants to act, in its own words.
   *
   * Shown to whoever has to approve it when the mandate says to ask first. A
   * request that cannot say why is a dare rather than a question, so there is a
   * default and it is honest about knowing nothing.
   */
  why?: string
}): Promise<ActOutcome> {
  const { jobs, jobId, action, callData, authorization, config } = input

  /*
   * The off-chain gate first, because it is the one that can say no cheaply and
   * explain itself, and because charging the cap and checking it happen in one
   * locked step. Two concurrent actions must not both fit under a limit only one
   * of them fits under.
   */
  const delegation = authorization.delegation as SignedDelegation | undefined
  /*
   * An unsigned mandate on a chain-capable deployment is a refusal, not an
   * allow.
   *
   * These two used to be one branch, and collapsing them was wrong in the worst
   * direction: on production, where a chain IS configured, an unsigned mandate
   * returned `allow` with no chain leg, charged the full amount against the
   * lifetime cap, and submitted nothing. Three sends in a row read as three
   * successes, moved nothing, and burned the cap. The caller could not tell that
   * from a real spend because the only difference was an absent field.
   *
   * Refused BEFORE `attempt`, so nothing is charged for an action that was never
   * going to be sent. This mirrors WATCH_UNSIGNED on the watch route, which has
   * always refused for the same reason.
   */
  if (config && !delegation)
    return {
      policy: {
        allow: false,
        rule: 'unsigned',
        reason:
          'This mandate has not been signed, so nothing on chain is holding its limits and no action can be submitted under it. Sign it first.',
      },
      heldBy: 'aiki',
    }
  if (!config) {
    /*
     * This deployment cannot reach a chain at all. The action is permitted and
     * AiKi is the only thing that held the limit, which is a real answer and has
     * to be reported as itself rather than as a chain outcome.
     */
    return { policy: await jobs.attempt(jobId, action, input.why), heldBy: 'aiki' }
  }
  // Narrowed by the two branches above; kept explicit so a later edit that
  // reorders them fails to compile rather than silently redeeming nothing.
  if (!delegation) throw new Error('Unreachable: a chain-configured action needs a delegation.')

  const { policy, outcome, inFlight } = await executeJobAction({
    jobs,
    jobId,
    ...(input.why ? { why: input.why } : {}),
    request: {
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      delegationManager: config.manager,
      relayerKey: config.agentKey,
      delegation: delegation as never,
      action,
      callData,
    },
  })
  if (!outcome) return { policy, heldBy: 'chain' }
  if (outcome.status === 'unconfirmed')
    return {
      policy,
      chain: {
        status: 'unconfirmed',
        ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
        revertReason: inFlight
          ? 'An execution is still in progress. Wait for its recorded result; do not repeat it.'
          : 'Execution needs review. The spending limit is held; do not repeat this action.',
      },
      heldBy: 'chain',
    }

  if (outcome.status !== 'landed') {
    /*
     * The chain refused what the off-chain engine allowed, and the cap was
     * already charged for it. Left alone, the counter would be ahead of reality
     * and every later action measured against money that never moved.
     *
     * This is also the case worth the whole product existing: the two engines
     * disagreed and the chain won.
     */
    await jobs.record(jobId, {
      type: 'policy',
      detail:
        outcome.status === 'refused'
          ? `chain would not accept it: ${outcome.revertReason ?? 'refused'}`
          : `chain refused it: ${outcome.revertReason ?? 'reverted'}`,
    })
    return {
      policy,
      chain: {
        status: outcome.status,
        ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
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
    chain: {
      status: 'landed',
      ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
    },
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

  /*
   * The selector that decides everything is the one in the calldata.
   *
   * A caller supplies both a selector and the calldata, and until these were
   * compared the policy engine checked the stated selector against the allowlist
   * while the chain executed whatever the calldata said. That is survivable for
   * the rules an enforcer also checks. It is not survivable for the destination
   * rule, which has no contract behind it and reads its argument at an offset
   * chosen by the selector: state `transfer` and send `transferFrom` calldata and
   * the "recipient" read out is the source address.
   *
   * Empty calldata carries no selector to compare against. It is left alone here
   * and refused on chain, where a call with no selector matches no allowlist.
   */
  const carried = selectorOf(body.callData)
  if (carried && carried !== selector)
    throw new ClientError(
      'The selector does not match the call being sent. Nothing was submitted.',
      { code: 'ACTION_SELECTOR_MISMATCH' },
    )

  return {
    action: {
      target,
      selector,
      asset,
      amount,
      at: new Date().toISOString(),
      // Read out of the calldata that will actually be executed, never taken
      // from the request, and at the offset that calldata's own selector names.
      recipient: recipientOf(carried ?? selector, body.callData),
    },
    callData: body.callData as Hex,
  }
}
