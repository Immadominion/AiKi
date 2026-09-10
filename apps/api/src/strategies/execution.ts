import { type Hex, keccak256 } from 'viem'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { executorAddress } from '../config/executor-identity.js'
import {
  type ExecutionOutcome,
  executeRedemption,
  type RedemptionRequest,
} from '../execution/executor.js'
import { assertStrategyEnvelope, encodeStrategyEnvelope } from './envelope.js'
import {
  encodeStrategyOperation,
  type StrategyOperation,
  strategyOperationDigest,
} from './operation.js'
import {
  type StrategyOutcome,
  type StrategyReceiptReader,
  verifyStrategyReceipt,
} from './receipt.js'
import { isVerifiedStrategySimulation, type StrategySimulationQuote } from './simulation.js'
import type { PostgresStrategyStore } from './store.js'

type Store = Pick<
  PostgresStrategyStore,
  'begin' | 'recordHash' | 'requireReview' | 'refuseBeforeBroadcast' | 'settle'
>
type Sender = (request: RedemptionRequest) => Promise<ExecutionOutcome>
export type StrategyExecutionResult =
  | { status: 'blocked'; reason: string }
  | { status: 'refused' | 'needs_review'; attemptId: string }
  | {
      status: 'landed' | 'reverted'
      attemptId: string
      transactionHash: Hex
      outcome?: StrategyOutcome
    }

/** One prepared operation, one durable signer claim, and one possible broadcast. No resend loop. */
export async function executeStrategyOperation(input: {
  store: Store
  watchId: string
  expectedRevision: string
  operation: StrategyOperation
  simulation: StrategySimulationQuote
  gasBudgetWei: bigint
  request: Omit<RedemptionRequest, 'target' | 'callData' | 'onPrepared' | 'maxGasCostWei'>
  reader: StrategyReceiptReader
  /** Injectable transport for tests; never taken from an HTTP request. */
  send?: Sender
}): Promise<StrategyExecutionResult> {
  // Do not copy stores/readers or persist the request: it contains a spending credential.
  const operation = structuredClone(input.operation),
    request = structuredClone(input.request)
  const watchId = input.watchId,
    expectedRevision = input.expectedRevision
  const { store, reader } = input
  const simulation = input.simulation,
    gasBudgetWei = input.gasBudgetWei
  let executor: Hex, callData: Hex, envelopeHash: Hex
  try {
    if (request.chainId !== 56 || request.delegationManager.toLowerCase() !== mainnet.manager)
      throw new Error('Strategy execution requires reviewed BSC mainnet configuration.')
    executor = executorAddress(request.relayerKey)
    callData = encodeStrategyOperation(operation)
    const envelope = encodeStrategyEnvelope(operation, request.delegation)
    assertStrategyEnvelope(envelope, operation, executor)
    envelopeHash = keccak256(envelope)
    if (
      !isVerifiedStrategySimulation(simulation) ||
      simulation.envelopeHash !== envelopeHash ||
      simulation.operationDigest !== strategyOperationDigest(operation) ||
      typeof gasBudgetWei !== 'bigint' ||
      gasBudgetWei <= 0n ||
      gasBudgetWei >= 1n << 256n ||
      simulation.gasUnits * simulation.gasPriceWei > gasBudgetWei
    )
      throw new Error('A fresh exact simulation within the execution gas budget is required.')
  } catch {
    return {
      status: 'blocked',
      reason: 'The signed strategy call does not match its mainnet configuration.',
    }
  }
  const claim = await store.begin({
    watchId,
    expectedRevision,
    operation,
    envelopeHash,
    manager: request.delegationManager,
    executor,
    simulation,
    gasBudgetWei,
  })
  if (!claim.acquired)
    return {
      status: 'blocked',
      reason:
        claim.reason === 'pending'
          ? 'A transaction is already pending. No new operation was sent.'
          : 'Refresh strategy state and readiness before this operation.',
    }
  const { attemptId } = claim
  const review = async (): Promise<StrategyExecutionResult> => {
    await store.requireReview(attemptId)
    return { status: 'needs_review', attemptId }
  }
  let preparedHash: Hex | undefined, outcome: ExecutionOutcome
  try {
    outcome = await (input.send ?? executeRedemption)({
      ...request,
      maxGasCostWei: gasBudgetWei,
      target: operation.binding.vault,
      callData,
      onPrepared: async (hash) => {
        await store.recordHash(attemptId, hash)
        preparedHash = hash.toLowerCase() as Hex
      },
    })
  } catch {
    return review()
  }
  if (outcome.status === 'refused' && !preparedHash && !outcome.transactionHash) {
    try {
      await store.refuseBeforeBroadcast(attemptId)
      return { status: 'refused', attemptId }
    } catch {
      // The pre-broadcast persistence callback may have committed before its acknowledgement was lost.
      return review()
    }
  }
  if (!preparedHash || outcome.transactionHash?.toLowerCase() !== preparedHash) return review()
  const verification = await verifyStrategyReceipt(
    {
      operation,
      transactionHash: preparedHash,
      manager: request.delegationManager,
      executor,
      envelopeHash,
    },
    reader,
  )
  if (verification.status !== 'verified') return review()
  const settled = await store.settle(attemptId, verification.receipt)
  if (settled === 'changed') return review()
  return {
    status: verification.receipt.status,
    attemptId,
    transactionHash: preparedHash,
    ...(verification.receipt.outcome ? { outcome: verification.receipt.outcome } : {}),
  }
}
