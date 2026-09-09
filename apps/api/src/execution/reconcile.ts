import type { ExecutionAttempt } from './attempts.js'
import { executionPending } from './attempts.js'

const HASH = /^0x[0-9a-fA-F]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && HASH.test(value) && !/^0x0{64}$/.test(value)
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export interface RecoveryAttempt extends ExecutionAttempt {
  /** Exact database version, used to refuse a concurrent state transition. */
  revision: string
}

export interface RecoveryTarget {
  attemptId: string
  chainId: 56 | 97
  transactionHash: `0x${string}`
}

export interface RecoveryEvidence {
  chainId: 56 | 97
  transactionHash: `0x${string}`
  blockNumber: string
  blockHash: `0x${string}`
  finalizedBlockNumber: string
  finalizedBlockHash: `0x${string}`
}

/** No signing, sending, transaction replacement, nonce changes or cap release API. */
export interface RecoveryReader {
  getChainId(): Promise<number>
  getTransactionReceipt(input: { hash: `0x${string}` }): Promise<unknown>
  getBlock(input: { blockTag: 'finalized' } | { blockNumber: bigint }): Promise<unknown>
}

export interface RecoveryStore {
  get(attemptId: string): Promise<RecoveryAttempt | null>
  finalizeSuccess(
    expected: RecoveryAttempt,
    evidence: RecoveryEvidence,
  ): Promise<'applied' | 'already_finalized' | 'changed'>
}

export interface RecoveryResult {
  status: 'ready' | 'applied' | 'already_finalized' | 'blocked' | 'changed'
  reason: string
  target: RecoveryTarget
  evidence?: RecoveryEvidence
}

export function validateRecoveryTarget(input: RecoveryTarget): RecoveryTarget {
  if (!UUID.test(input.attemptId)) throw new Error('Name one valid execution attempt UUID.')
  if (input.chainId !== 56 && input.chainId !== 97)
    throw new Error('Choose the recorded BNB execution chain, 56 or 97.')
  if (!hash(input.transactionHash)) throw new Error('Name the exact recorded transaction hash.')
  return {
    attemptId: input.attemptId.toLowerCase(),
    chainId: input.chainId,
    transactionHash: input.transactionHash.toLowerCase() as `0x${string}`,
  }
}

export function parseRecoveryArguments(
  args: readonly string[],
): RecoveryTarget & { apply: boolean } {
  const values = new Map<string, string>()
  let apply = false
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply' && !apply) {
      apply = true
      continue
    }
    if (!flag || !['--attempt', '--chain', '--hash'].includes(flag) || values.has(flag))
      throw new Error('Use --attempt UUID --chain 56|97 --hash HASH, with optional --apply.')
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`A value is required for ${flag}.`)
    values.set(flag, value)
  }
  const chain = values.get('--chain')
  if (chain !== '56' && chain !== '97') throw new Error('Choose --chain 56 or --chain 97.')
  return {
    ...validateRecoveryTarget({
      attemptId: values.get('--attempt') ?? '',
      chainId: Number(chain) as 56 | 97,
      transactionHash: (values.get('--hash') ?? '') as `0x${string}`,
    }),
    apply,
  }
}

/**
 * Reconcile one exact durable hash. A finalized success keeps spend counted.
 * Legacy attempts have no atomically recorded reservation amount, so even a
 * finalized revert cannot justify a cap release or unlocking for another send.
 */
export async function reconcileExecution(input: {
  target: RecoveryTarget
  apply?: boolean
  store: RecoveryStore
  reader: RecoveryReader
}): Promise<RecoveryResult> {
  const target = validateRecoveryTarget(input.target)
  const blocked = (reason: string): RecoveryResult => ({ status: 'blocked', reason, target })
  const attempt = await input.store.get(target.attemptId)
  if (!attempt) return blocked('The execution attempt was not found. Nothing was changed.')
  if (
    attempt.chainId !== target.chainId ||
    attempt.transactionHash?.toLowerCase() !== target.transactionHash
  )
    return blocked(
      'The recorded chain and hash must match exactly. The lock and cap were not changed.',
    )
  if (attempt.state === 'LANDED')
    return {
      status: 'already_finalized',
      reason: 'This exact attempt is already recorded as landed. Nothing was changed.',
      target,
    }
  if (!executionPending(attempt.state))
    return blocked(
      'This attempt is already terminal. Reconciliation will not overwrite its history.',
    )

  let evidence: RecoveryEvidence
  try {
    if ((await input.reader.getChainId()) !== target.chainId)
      return blocked('The RPC is on a different chain. The lock and cap were not changed.')
    const receipt = object(
      await input.reader.getTransactionReceipt({ hash: target.transactionHash }),
    )
    if (
      !receipt ||
      !hash(receipt.transactionHash) ||
      receipt.transactionHash.toLowerCase() !== target.transactionHash ||
      !hash(receipt.blockHash) ||
      typeof receipt.blockNumber !== 'bigint' ||
      receipt.blockNumber < 0n ||
      (receipt.status !== 'success' && receipt.status !== 'reverted')
    )
      return blocked(
        'The receipt identity or outcome could not be verified. The lock and cap remain held.',
      )
    const finalized = object(await input.reader.getBlock({ blockTag: 'finalized' }))
    if (
      !finalized ||
      typeof finalized.number !== 'bigint' ||
      finalized.number < 0n ||
      !hash(finalized.hash)
    )
      return blocked(
        'The RPC did not provide a valid finalized block. The lock and cap remain held.',
      )
    if (
      finalized.number < receipt.blockNumber ||
      (finalized.number === receipt.blockNumber &&
        finalized.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
    )
      return blocked('This receipt is not proven finalized. The lock and cap remain held.')
    // Recheck canonicality AFTER finality: a fork change during the finalized
    // lookup must not let a previously canonical but now orphaned receipt pass.
    const canonical = object(await input.reader.getBlock({ blockNumber: receipt.blockNumber }))
    if (
      !canonical ||
      canonical.number !== receipt.blockNumber ||
      !hash(canonical.hash) ||
      canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
    )
      return blocked('The receipt block is not verified canonical. The lock and cap remain held.')
    if ((await input.reader.getChainId()) !== target.chainId)
      return blocked('The RPC chain changed during verification. The lock and cap remain held.')
    if (receipt.status === 'reverted')
      return blocked(
        'The exact transaction reverted and is finalized, but this legacy attempt does not prove its reserved amount. No refund or unlock is permitted; the lock and cap remain held for reviewed accounting recovery.',
      )
    evidence = {
      chainId: target.chainId,
      transactionHash: target.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash.toLowerCase() as `0x${string}`,
      finalizedBlockNumber: finalized.number.toString(),
      finalizedBlockHash: finalized.hash.toLowerCase() as `0x${string}`,
    }
  } catch {
    return blocked(
      'Receipt or finality verification is unavailable. No retry, refund or unlock was performed.',
    )
  }
  if (!input.apply)
    return {
      status: 'ready',
      reason:
        'Dry run: finalized success verified. Applying will close this attempt as LANDED, retain counted spend, and not restart a stopped watch or send any transaction.',
      target,
      evidence,
    }
  const status = await input.store.finalizeSuccess(attempt, evidence)
  return {
    status,
    reason:
      status === 'applied'
        ? 'Recorded finalized success as LANDED. Counted spend is unchanged. No watch was restarted and no transaction was sent.'
        : status === 'already_finalized'
          ? 'Another caller already recorded this exact attempt as landed. Nothing was changed.'
          : 'The attempt changed during verification. Nothing was changed; inspect it again before retrying.',
    target,
    evidence,
  }
}
