import {
  GridStrategyVaultAbi,
  PancakeLPVaultAbi,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import { decodeEventLog, type Hex, keccak256 } from 'viem'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { assertStrategyEnvelope } from './envelope.js'
import {
  encodeStrategyOperation,
  nonzeroAddress,
  nonzeroHash,
  STRATEGY_KIND_HASH,
  type StrategyOperation,
  strategyOperationDigest,
  strategyPlanHash,
} from './operation.js'

export interface StrategyReceiptTarget {
  operation: StrategyOperation
  transactionHash: Hex
  manager: Hex
  executor: Hex
  /** Hash of the complete manager redemption calldata, not just the inner vault call. */
  envelopeHash: Hex
}

/** Read-only. Both normal settlement and recovery must use this same verifier. */
export interface StrategyReceiptReader {
  getChainId(): Promise<number>
  getTransactionReceipt(input: { hash: Hex }): Promise<unknown>
  getTransaction(input: { hash: Hex }): Promise<unknown>
  getBlock(input: { blockTag: 'finalized' } | { blockNumber: bigint }): Promise<unknown>
  getBytecode(input: { address: Hex; blockNumber: bigint }): Promise<Hex | undefined>
  readContract(input: {
    address: Hex
    abi: typeof YieldAllocationVaultAbi
    functionName: 'controller' | 'policyHash' | 'strategyKind'
    blockNumber: bigint
  }): Promise<unknown>
}

export type StrategyOutcome =
  | {
      kind: 'yield'
      movedAssets: string
      assetsBefore: string
      assetsAfter: string
      loss: string
      idle: string
      venusShares: string
      aaveScaled: string
    }
  | { kind: 'grid'; filled: false; baseline: boolean; spot: number; twap: number }
  | {
      kind: 'grid'
      filled: true
      baseline: false
      spot: number
      twap: number
      rung: number
      cycleBefore: string
      soldToken0: boolean
      actualInput: string
      actualOutput: string
      inventory0: string
      inventory1: string
    }
  | {
      kind: 'lp'
      oldTokenId: string
      newTokenId: string
      liquidity: string
      amountIn: string
      amountOut: string
      lossQuote: string
      idle0: string
      idle1: string
    }

const verified = Symbol('verified-strategy-receipt')
const issuedReceipts = new WeakSet<object>()
export interface VerifiedStrategyReceipt {
  readonly [verified]: true
  chainId: 56
  transactionHash: Hex
  blockNumber: string
  blockHash: Hex
  finalizedBlockNumber: string
  finalizedBlockHash: Hex
  vault: Hex
  policyHash: Hex
  callDataHash: Hex
  operationDigest: Hex
  manager: Hex
  executor: Hex
  envelopeHash: Hex
  expectedNonce: string
  /** A revert proves no transition by this attempt, not the vault's current owner-changed nonce. */
  nextNonce: string | null
  status: 'landed' | 'reverted'
  outcome?: StrategyOutcome
}

export function isVerifiedStrategyReceipt(value: unknown): value is VerifiedStrategyReceipt {
  return typeof value === 'object' && value !== null && issuedReceipts.has(value)
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing chain object.')
  return value as Record<string, unknown>
}
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const uint = (value: unknown): bigint => {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('Invalid chain quantity.')
  return value
}
const hexBytes = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value)

function verifiedOutcome(
  operation: StrategyOperation,
  logs: Record<string, unknown>[],
): StrategyOutcome {
  const abi =
    operation.kind === 'yield'
      ? YieldAllocationVaultAbi
      : operation.kind === 'grid'
        ? GridStrategyVaultAbi
        : PancakeLPVaultAbi
  const events = logs.map((log) =>
    decodeEventLog({
      abi,
      strict: true,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
    }),
  )
  const named = (name: string) => events.filter((e) => e.eventName === name)
  const one = (name: string) => {
    const matches = named(name)
    if (matches.length !== 1) throw new Error('Expected one exact strategy event.')
    return object(matches[0]?.args)
  }
  const completion = one('StrategyExecuted')
  const nonce = operation.expectedNonce + 1n
  if (!same(completion.policyHash, operation.binding.policyHash) || completion.nonce !== nonce)
    throw new Error('Strategy completion identity mismatch.')
  let result: StrategyOutcome
  let observation: { spot: number; twap: number; baseline: boolean } | undefined
  if (operation.kind === 'yield') {
    if (events.length !== 2) throw new Error('Unexpected yield events.')
    const moved = one('YieldMoved')
    if (
      moved.nonce !== nonce ||
      moved.source !== operation.source ||
      moved.destination !== operation.destination ||
      moved.requestedAssets !== operation.assets ||
      uint(moved.movedAssets) < operation.minReceived ||
      uint(moved.movedAssets) > operation.assets
    )
      throw new Error('Yield outcome differs from the prepared move.')
    result = {
      kind: 'yield',
      movedAssets: uint(moved.movedAssets).toString(),
      assetsBefore: uint(moved.assetsBefore).toString(),
      assetsAfter: uint(moved.assetsAfter).toString(),
      loss: uint(moved.loss).toString(),
      idle: uint(moved.idle).toString(),
      venusShares: uint(moved.venusShares).toString(),
      aaveScaled: uint(moved.aaveScaled).toString(),
    }
  } else if (operation.kind === 'lp') {
    if (events.length !== 2) throw new Error('Unexpected LP events.')
    const lp = one('Rebalanced')
    if (
      !same(lp.policyHash, operation.binding.policyHash) ||
      lp.nonce !== nonce ||
      lp.oldTokenId !== operation.expectedTokenId ||
      uint(lp.newTokenId) === 0n ||
      lp.newTokenId === lp.oldTokenId ||
      uint(lp.liquidity) < operation.minLiquidity ||
      uint(lp.amountIn) > operation.swapAmount ||
      uint(lp.amountOut) < operation.minSwapOut ||
      (operation.swapAmount === 0n && (lp.amountIn !== 0n || lp.amountOut !== 0n)) ||
      (operation.swapAmount > 0n && (lp.amountIn === 0n || lp.amountOut === 0n))
    )
      throw new Error('LP replacement differs from the prepared position.')
    result = {
      kind: 'lp',
      oldTokenId: uint(lp.oldTokenId).toString(),
      newTokenId: uint(lp.newTokenId).toString(),
      liquidity: uint(lp.liquidity).toString(),
      amountIn: uint(lp.amountIn).toString(),
      amountOut: uint(lp.amountOut).toString(),
      lossQuote: uint(lp.lossQuote).toString(),
      idle0: uint(lp.idle0).toString(),
      idle1: uint(lp.idle1).toString(),
    }
  } else {
    const observed = one('GridObserved')
    if (
      observed.operationNonce !== nonce ||
      observed.baseline !== operation.baseline ||
      typeof observed.spot !== 'number' ||
      typeof observed.twap !== 'number'
    )
      throw new Error('Grid observation differs from prepared state.')
    observation = { spot: observed.spot, twap: observed.twap, baseline: operation.baseline }
    if (named('GridFilled').length === 0) {
      if (events.length !== 2) throw new Error('Unexpected observation events.')
      result = { kind: 'grid', filled: false, ...observation }
    } else {
      if (events.length !== 3 || operation.baseline) throw new Error('Baseline must never trade.')
      const fill = one('GridFilled')
      const before = operation.before
      const spent = uint(fill.actualInput),
        received = uint(fill.actualOutput)
      if (
        fill.operationNonce !== nonce ||
        fill.rung !== operation.rungIndex ||
        fill.cycle !== before.cycle ||
        fill.soldToken0 !== before.nextSell ||
        spent === 0n ||
        received === 0n ||
        (before.nextSell
          ? spent > before.inventory0 ||
            fill.inventory0 !== before.inventory0 - spent ||
            fill.inventory1 !== before.inventory1 + received
          : spent > before.inventory1 ||
            fill.inventory1 !== before.inventory1 - spent ||
            fill.inventory0 !== before.inventory0 + received)
      )
        throw new Error('Grid fill does not reconcile with prior inventory.')
      result = {
        kind: 'grid',
        filled: true,
        baseline: false,
        spot: observation.spot,
        twap: observation.twap,
        rung: operation.rungIndex,
        cycleBefore: before.cycle.toString(),
        soldToken0: before.nextSell,
        actualInput: spent.toString(),
        actualOutput: received.toString(),
        inventory0: uint(fill.inventory0).toString(),
        inventory1: uint(fill.inventory1).toString(),
      }
    }
  }
  if (!same(completion.planHash, strategyPlanHash(operation, observation)))
    throw new Error('Strategy plan commitment mismatch.')
  return result
}

/** No successful receipt, provider result or retry may substitute for verified strategy effects. */
export async function verifyStrategyReceipt(
  input: StrategyReceiptTarget,
  reader: StrategyReceiptReader,
): Promise<
  { status: 'verified'; receipt: VerifiedStrategyReceipt } | { status: 'blocked'; reason: string }
> {
  try {
    // Verification must not follow mutations of a caller-owned plan during RPC awaits.
    const target = structuredClone(input)
    const callData = encodeStrategyOperation(target.operation)
    if (
      !nonzeroHash(target.transactionHash) ||
      !nonzeroHash(target.envelopeHash) ||
      !same(target.manager, mainnet.manager) ||
      !nonzeroAddress(target.executor)
    )
      throw new Error('Invalid target.')
    if ((await reader.getChainId()) !== 56) throw new Error('Wrong chain.')
    const receipt = object(await reader.getTransactionReceipt({ hash: target.transactionHash }))
    if (
      !same(receipt.transactionHash, target.transactionHash) ||
      !nonzeroHash(receipt.blockHash) ||
      (receipt.status !== 'success' && receipt.status !== 'reverted')
    )
      throw new Error('Wrong receipt.')
    const blockNumber = uint(receipt.blockNumber)
    const tx = object(await reader.getTransaction({ hash: target.transactionHash }))
    if (
      !same(tx.hash, target.transactionHash) ||
      !same(tx.to, target.manager) ||
      !same(tx.from, target.executor) ||
      !same(tx.blockHash, receipt.blockHash) ||
      tx.blockNumber !== blockNumber ||
      tx.value !== 0n ||
      !hexBytes(tx.input) ||
      !same(keccak256(tx.input), target.envelopeHash)
    )
      throw new Error('Wrong transaction envelope.')
    assertStrategyEnvelope(tx.input, target.operation, target.executor)
    const managerCode = await reader.getBytecode({ address: target.manager, blockNumber })
    if (!managerCode || !same(keccak256(managerCode), mainnet.managerCodeHash))
      throw new Error('Unreviewed manager runtime.')
    const binding = target.operation.binding
    const code = await reader.getBytecode({ address: binding.vault, blockNumber })
    if (!code || code === '0x' || !same(keccak256(code), binding.runtimeCodeHash))
      throw new Error('Unverified vault code.')
    for (const [functionName, expected] of [
      ['controller', binding.controller],
      ['policyHash', binding.policyHash],
      ['strategyKind', STRATEGY_KIND_HASH[binding.kind]],
    ] as const) {
      if (
        !same(
          await reader.readContract({
            address: binding.vault,
            abi: YieldAllocationVaultAbi,
            functionName,
            blockNumber,
          }),
          expected,
        )
      )
        throw new Error('Vault binding mismatch.')
    }
    if (!Array.isArray(receipt.logs)) throw new Error('Missing receipt logs.')
    const seen = new Set<number>()
    const ownLogs: Record<string, unknown>[] = []
    for (const value of receipt.logs) {
      const log = object(value)
      if (!same(log.address, binding.vault)) continue
      if (
        log.removed !== false ||
        !same(log.transactionHash, target.transactionHash) ||
        !same(log.blockHash, receipt.blockHash) ||
        log.blockNumber !== blockNumber ||
        typeof log.logIndex !== 'number' ||
        !Number.isSafeInteger(log.logIndex) ||
        log.logIndex < 0 ||
        seen.has(log.logIndex) ||
        !hexBytes(log.data) ||
        !Array.isArray(log.topics) ||
        !log.topics.length ||
        !log.topics.every((topic) => typeof topic === 'string' && /^0x[0-9a-f]{64}$/i.test(topic))
      )
        throw new Error('Unverified strategy log.')
      seen.add(log.logIndex)
      ownLogs.push(log)
    }
    let outcome: StrategyOutcome | undefined
    if (receipt.status === 'success') outcome = verifiedOutcome(target.operation, ownLogs)
    else if (ownLogs.length !== 0)
      throw new Error('Reverted transaction contains strategy effects.')
    // Check finality and then canonicality AFTER all historical reads, not before them.
    const finalized = object(await reader.getBlock({ blockTag: 'finalized' }))
    if (
      uint(finalized.number) < blockNumber ||
      !nonzeroHash(finalized.hash) ||
      (finalized.number === blockNumber && !same(finalized.hash, receipt.blockHash))
    )
      throw new Error('Not finalized.')
    const canonical = object(await reader.getBlock({ blockNumber }))
    if (
      canonical.number !== blockNumber ||
      !same(canonical.hash, receipt.blockHash) ||
      (await reader.getChainId()) !== 56
    )
      throw new Error('Not canonical.')
    const evidence: VerifiedStrategyReceipt = {
      [verified]: true,
      chainId: 56,
      transactionHash: target.transactionHash.toLowerCase() as Hex,
      blockNumber: blockNumber.toString(),
      blockHash: receipt.blockHash.toLowerCase() as Hex,
      finalizedBlockNumber: uint(finalized.number).toString(),
      finalizedBlockHash: finalized.hash.toLowerCase() as Hex,
      vault: binding.vault.toLowerCase() as Hex,
      policyHash: binding.policyHash.toLowerCase() as Hex,
      callDataHash: keccak256(callData),
      expectedNonce: target.operation.expectedNonce.toString(),
      operationDigest: strategyOperationDigest(target.operation),
      manager: target.manager.toLowerCase() as Hex,
      executor: target.executor.toLowerCase() as Hex,
      envelopeHash: target.envelopeHash.toLowerCase() as Hex,
      nextNonce: outcome ? (target.operation.expectedNonce + 1n).toString() : null,
      status: outcome ? 'landed' : 'reverted',
      ...(outcome ? { outcome: Object.freeze(outcome) } : {}),
    }
    issuedReceipts.add(evidence)
    return { status: 'verified', receipt: Object.freeze(evidence) }
  } catch {
    return {
      status: 'blocked',
      reason:
        'The exact transaction, strategy result or finalized chain state could not be verified. The execution remains locked for review.',
    }
  }
}
