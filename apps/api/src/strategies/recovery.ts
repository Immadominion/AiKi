import type { Hex } from 'viem'
import {
  type StrategyOutcome,
  type StrategyReceiptReader,
  verifyStrategyReceipt,
} from './receipt.js'
import type { PostgresStrategyStore } from './store.js'

export type StrategyRecoveryResult =
  | { status: 'not_found' | 'needs_review'; attemptId: string }
  | {
      status: 'landed' | 'reverted'
      attemptId: string
      transactionHash: Hex
      outcome?: StrategyOutcome
    }

/**
 * Reconcile one immutable stored attempt. Recovery has no credential or send path.
 * Receipt evidence is transaction-local, not fresh custody state or permission to
 * restart: only the shared atomic settlement method can record the terminal state.
 */
export async function recoverStrategyOperation(input: {
  store: Pick<PostgresStrategyStore, 'getPendingAttempt' | 'settle' | 'requireReview'>
  attemptId: string
  reader: StrategyReceiptReader
}): Promise<StrategyRecoveryResult> {
  const { store, attemptId, reader } = input
  const review = async (): Promise<StrategyRecoveryResult> => {
    try {
      await store.requireReview(attemptId)
    } catch {
      // A database outage cannot release the durable claim. Do not claim that
      // marking review succeeded, or turn a lost commit acknowledgement into a retry.
    }
    return { status: 'needs_review', attemptId }
  }
  try {
    const stored = await store.getPendingAttempt(attemptId)
    if (stored === null) return { status: 'not_found', attemptId }
    // Capture identity and the complete prepared operation before any RPC await.
    const target = structuredClone(stored)
    if (target.attemptId !== attemptId || target.transactionHash === null) return review()
    const verification = await verifyStrategyReceipt(
      {
        operation: target.operation,
        transactionHash: target.transactionHash,
        manager: target.manager,
        executor: target.executor,
        envelopeHash: target.envelopeHash,
      },
      reader,
    )
    if (verification.status !== 'verified') return review()
    const settled = await store.settle(attemptId, verification.receipt)
    if (settled !== 'applied' && settled !== 'already_settled') return review()
    return {
      status: verification.receipt.status,
      attemptId,
      transactionHash: verification.receipt.transactionHash,
      ...(verification.receipt.outcome ? { outcome: verification.receipt.outcome } : {}),
    }
  } catch {
    return review()
  }
}
