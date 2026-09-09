import { executorAddress } from '../config/executor-identity.js'
import type { JobService } from '../jobs/service.js'
import { unresolvedExecutionMessage } from './attempts.js'
import { type ExecutionOutcome, type ExecutionRequest, execute } from './executor.js'

/** Durable mandate and chain/signer locks cover the hold through finality or review. */
export async function executeJobAction(input: {
  jobs: JobService
  jobId: string
  request: ExecutionRequest
  why?: string
}) {
  const { jobs, jobId, request } = input
  const claimed = await jobs.beginExecution(
    jobId,
    request.chainId,
    executorAddress(request.relayerKey),
  )
  if (!claimed.acquired && claimed.scope === 'executor')
    return {
      inFlight: true,
      policy: {
        allow: false,
        rule: 'executor_pending',
        reason:
          'The execution signer is busy with another pending transaction. This action is deferred; no spending limit was reserved.',
      },
      // A different owner's hash and mandate identity must never leave here.
      outcome: { status: 'unconfirmed', gasUsed: 0n } satisfies ExecutionOutcome,
    }
  if (!claimed.acquired)
    return {
      inFlight: claimed.attempt.state !== 'UNCONFIRMED',
      policy: {
        allow: false,
        rule:
          claimed.attempt.state === 'UNCONFIRMED' ? 'execution_unconfirmed' : 'execution_pending',
        reason: unresolvedExecutionMessage(claimed.attempt),
      },
      outcome: {
        status: 'unconfirmed',
        gasUsed: 0n,
        ...(claimed.attempt.transactionHash
          ? { transactionHash: claimed.attempt.transactionHash }
          : {}),
      } satisfies ExecutionOutcome,
    }
  const id = claimed.attempt.id
  // If policy persistence throws, its commit may have succeeded. The claim is
  // intentionally retained until an operator checks it, not expired or retried.
  const policy = await jobs.attempt(jobId, request.action, input.why)
  if (!policy.allow) {
    await jobs.finishExecution(id, 'REFUSED')
    return { policy }
  }
  let outcome: ExecutionOutcome
  try {
    outcome = await execute({
      ...request,
      onPrepared: (hash) => jobs.recordExecutionHash(id, hash),
    })
  } catch {
    // An unexpected adapter failure must never imply that no payment was sent.
    const pending = await jobs.pendingExecution(claimed.attempt.authorizationId)
    outcome = {
      status: 'unconfirmed',
      gasUsed: 0n,
      ...(pending?.transactionHash ? { transactionHash: pending.transactionHash } : {}),
      revertReason: 'Execution outcome needs review. No automatic retry will be made.',
    }
  }
  if (outcome.transactionHash) await jobs.recordExecutionHash(id, outcome.transactionHash)
  await jobs.finishExecution(
    id,
    outcome.status.toUpperCase() as 'LANDED' | 'REVERTED' | 'REFUSED' | 'UNCONFIRMED',
    outcome.status === 'refused' || outcome.status === 'reverted' ? request.action.amount : 0n,
  )
  return { policy, outcome }
}
