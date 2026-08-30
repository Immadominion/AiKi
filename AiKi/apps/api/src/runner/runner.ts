import type { Address, Hex } from 'viem'
import type { Action } from '../authority/policy.js'
import { type ExecutionRequest, erc20TransferCall, execute } from '../execution/executor.js'
import type { JobService } from '../jobs/service.js'
import { type Assessment, decide, type TriggerState } from './trigger.js'

/**
 * One pass of an agent watching a position.
 *
 * The order here is the product. The agent's own assessment decides whether
 * anything should happen; the policy engine decides whether it is permitted; the
 * chain decides whether it lands. Each stage can refuse, each refusal is
 * recorded against the job, and nothing skips a stage. In particular the policy
 * check is not advisory: an action the engine denies never reaches the executor,
 * so a bug in an agent cannot spend money a mandate did not allow.
 *
 * A tick that does nothing is the normal case and is reported as such. An agent
 * that only speaks when it acts leaves the user unable to tell "watching, all
 * well" from "stopped running three days ago", which is the difference between a
 * guardian and a screensaver.
 */
export interface TickResult {
  acted: boolean
  reason: string
  repay?: bigint
  transactionHash?: Hex
  deniedBy?: string
}

export interface TickInput {
  jobs: JobService
  jobId: string
  assessment: Assessment
  state: TriggerState
  /** Where the repayment is sent, and in what. */
  asset: Address
  repayTo: Address
  chain: Omit<ExecutionRequest, 'delegation' | 'action' | 'callData'>
  delegation: ExecutionRequest['delegation']
  now?: () => number
}

export async function tick(input: TickInput): Promise<TickResult> {
  const decision = decide(input.assessment, input.state, input.now?.() ?? Date.now())
  if (!decision.act) return { acted: false, reason: decision.reason }

  const action: Action = {
    target: input.asset,
    selector: '0xa9059cbb',
    asset: input.asset,
    amount: decision.repay,
    at: new Date(input.now?.() ?? Date.now()).toISOString(),
  }

  // The mandate rules before anything is sent. This is the stage that makes an
  // agent's bug a refused action rather than a loss.
  const verdict = await input.jobs.attempt(input.jobId, action)
  if (!verdict.allow)
    return {
      acted: false,
      reason: `The mandate refused it: ${verdict.reason}`,
      deniedBy: verdict.rule,
    }

  const outcome = await execute({
    ...input.chain,
    delegation: input.delegation,
    action,
    callData: erc20TransferCall(input.repayTo, decision.repay),
  })

  if (outcome.status !== 'landed')
    return {
      acted: false,
      reason: `The chain refused it: ${outcome.revertReason ?? 'reverted'}`,
      deniedBy: 'chain',
      repay: decision.repay,
    }

  return {
    acted: true,
    reason: decision.reason,
    repay: decision.repay,
    ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
  }
}
