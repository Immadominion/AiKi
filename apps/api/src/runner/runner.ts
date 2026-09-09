import type { Address, Hex } from 'viem'
import type { Action } from '../authority/policy.js'
import { type ExecutionRequest, venusRepayCall } from '../execution/executor.js'
import { executeJobAction } from '../execution/job-execution.js'
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
  needsReview?: boolean
}

export interface TickInput {
  jobs: JobService
  jobId: string
  assessment: Assessment
  state: TriggerState
  /** What is repaid, and the market the debt is held in. */
  asset: Address
  market: Address
  chain: Omit<ExecutionRequest, 'delegation' | 'action' | 'callData'>
  delegation: ExecutionRequest['delegation']
  now?: () => number
}

export async function tick(input: TickInput): Promise<TickResult> {
  const decision = decide(input.assessment, input.state, input.now?.() ?? Date.now())
  if (!decision.act) return { acted: false, reason: decision.reason }

  const action: Action = {
    /*
     * The market, not the token. Repaying is a call on the lending market that
     * pulls the underlying; sending the token to the market instead donates it
     * to the pool and leaves the borrow exactly where it was.
     */
    target: input.market,
    selector: '0x0e752702',
    asset: input.asset,
    amount: decision.repay,
    at: new Date(input.now?.() ?? Date.now()).toISOString(),
  }

  // The mandate rules before anything is sent. This is the stage that makes an
  // agent's bug a refused action rather than a loss. The agent's own reason for
  // acting goes with it, because a mandate that asks a person first has to be
  // able to tell them what they are being asked about.
  const {
    policy: verdict,
    outcome,
    inFlight,
  } = await executeJobAction({
    jobs: input.jobs,
    jobId: input.jobId,
    why: decision.reason,
    request: {
      ...input.chain,
      delegation: input.delegation,
      action,
      callData: venusRepayCall(decision.repay),
    },
  })
  if (outcome?.status === 'unconfirmed')
    return {
      acted: false,
      needsReview: !inFlight,
      reason: inFlight
        ? 'Another execution is still in progress. This repayment will wait; no new transaction was sent.'
        : 'A repayment needs review. The spending limit is held and no new transaction will be sent.',
      deniedBy: inFlight ? 'execution_pending' : 'execution_unconfirmed',
      repay: decision.repay,
      ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
    }
  if (!verdict.allow)
    return {
      acted: false,
      /*
       * Waiting is not refusing, and saying "the mandate refused it" about an
       * action sitting in somebody's approval queue would be the wrong sentence
       * on a screen they are meant to act on. The next tick picks it up once
       * they answer.
       */
      reason:
        verdict.rule === 'approval_required'
          ? `Waiting for you: ${decision.reason}`
          : `The mandate refused it: ${verdict.reason}`,
      deniedBy: verdict.rule,
    }

  if (!outcome) throw new Error('Execution result is missing.')
  if (outcome.status !== 'landed') {
    /*
     * Give the cap back. `attempt` charged it before the chain had spoken,
     * because checking and charging have to happen in one locked step, and the
     * chain then refused. Left alone the counter would be ahead of reality.
     *
     * This matters far more on a loop than it does on a one-off action. A watch
     * that fails four times against a 100 cap has spent nothing and has no room
     * left, so the agent stops protecting the position for a reason that never
     * happened. Looked up rather than passed in, so a caller cannot forget it.
     */
    await input.jobs.record(input.jobId, {
      type: 'policy',
      detail: `chain refused it: ${outcome.revertReason ?? 'reverted'}`,
    })
    return {
      acted: false,
      reason: `The chain refused it: ${outcome.revertReason ?? 'reverted'}`,
      deniedBy: 'chain',
      repay: decision.repay,
    }
  }

  return {
    acted: true,
    reason: decision.reason,
    repay: decision.repay,
    ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
  }
}
