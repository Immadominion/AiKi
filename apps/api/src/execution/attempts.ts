export type ExecutionState =
  | 'PREPARING'
  | 'SUBMITTED'
  | 'UNCONFIRMED'
  | 'LANDED'
  | 'REVERTED'
  | 'REFUSED'

export interface ExecutionAttempt {
  id: string
  authorizationId: string
  jobId: string
  chainId: number
  state: ExecutionState
  transactionHash?: `0x${string}`
  createdAt: string
}

export const executionPending = (state: ExecutionState) =>
  state === 'PREPARING' || state === 'SUBMITTED' || state === 'UNCONFIRMED'

export const unresolvedExecutionMessage = (
  attempt: Pick<ExecutionAttempt, 'transactionHash' | 'state'>,
) =>
  `${attempt.state === 'UNCONFIRMED' ? 'An execution needs review. Its spending limit remains reserved and no new action will be sent.' : 'An execution is still in progress. No new action will be sent until it finishes.'}${attempt.transactionHash ? ` Transaction: ${attempt.transactionHash}.` : ''}`
