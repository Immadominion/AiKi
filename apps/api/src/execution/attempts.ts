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
  /** Actual signing address. Missing on legacy attempts: blocks every signer on this chain. */
  executorAddress?: `0x${string}`
  state: ExecutionState
  transactionHash?: `0x${string}`
  createdAt: string
}

export const executionPending = (state: ExecutionState) =>
  state === 'PREPARING' || state === 'SUBMITTED' || state === 'UNCONFIRMED'

export function normalizeExecutionSender(address: string): `0x${string}` {
  if (!/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address))
    throw new Error('Execution signer address is invalid.')
  return address.toLowerCase() as `0x${string}`
}

export const executionSenderConflicts = (
  attempt: ExecutionAttempt,
  chainId: number,
  address?: string,
) =>
  executionPending(attempt.state) &&
  attempt.chainId === chainId &&
  (!address ||
    !attempt.executorAddress ||
    attempt.executorAddress.toLowerCase() === address.toLowerCase())

export const unresolvedExecutionMessage = (
  attempt: Pick<ExecutionAttempt, 'transactionHash' | 'state'>,
) =>
  `${attempt.state === 'UNCONFIRMED' ? 'An execution needs review. Its spending limit remains reserved and no new action will be sent.' : 'An execution is still in progress. No new action will be sent until it finishes.'}${attempt.transactionHash ? ` Transaction: ${attempt.transactionHash}.` : ''}`
