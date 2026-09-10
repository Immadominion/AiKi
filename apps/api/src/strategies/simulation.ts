import type { Hex } from 'viem'
import { keccak256 } from 'viem'
import type { SignedDelegation } from '../execution/executor.js'
import { assertStrategyEnvelope, encodeStrategyEnvelope } from './envelope.js'
import { assertStrategyGrant } from './grant.js'
import { type StrategyOperation, strategyOperationDigest } from './operation.js'
import { isVerifiedStrategySnapshot, type VerifiedStrategySnapshot } from './snapshot.js'

interface SimulatedCall {
  account: Hex
  to: Hex
  data: Hex
  value: 0n
  blockNumber: bigint
}
export interface StrategySimulationReader {
  getChainId(): Promise<number>
  getGasPrice(): Promise<bigint>
  call(input: SimulatedCall): Promise<unknown>
  estimateGas(input: SimulatedCall): Promise<bigint>
  getBlock(input: { blockNumber: bigint }): Promise<unknown>
}

const issuedQuotes = new WeakSet<object>()
const verified = Symbol('verified-strategy-simulation')
export interface StrategySimulationQuote {
  readonly [verified]: true
  readonly status: 'simulated'
  readonly path: 'manager-delegation'
  readonly blockNumber: bigint
  readonly blockHash: Hex
  readonly operationDigest: Hex
  readonly envelopeHash: Hex
  readonly gasUnits: bigint
  readonly gasPriceWei: bigint
}
export function isVerifiedStrategySimulation(value: unknown): value is StrategySimulationQuote {
  return typeof value === 'object' && value !== null && issuedQuotes.has(value)
}

/** Simulate the exact entire account/manager/vault call. No state overrides, signing or sending. */
export async function quoteStrategyOperation(input: {
  operation: StrategyOperation
  snapshot: VerifiedStrategySnapshot
  delegation: SignedDelegation
  executor: Hex
  reader: StrategySimulationReader
}): Promise<StrategySimulationQuote | { status: 'blocked'; reason: string }> {
  try {
    const { reader, snapshot } = input
    const operation = structuredClone(input.operation),
      delegation = structuredClone(input.delegation),
      executor = input.executor
    if (
      !isVerifiedStrategySnapshot(snapshot) ||
      snapshot.paused ||
      snapshot.expiresAt <= snapshot.block.timestamp ||
      operation.expectedNonce !== snapshot.nonce ||
      operation.binding.vault.toLowerCase() !== snapshot.binding.vault ||
      operation.binding.controller.toLowerCase() !== snapshot.binding.controller ||
      operation.binding.policyHash.toLowerCase() !== snapshot.binding.policyHash ||
      operation.binding.runtimeCodeHash.toLowerCase() !== snapshot.binding.runtimeCodeHash ||
      operation.kind !== snapshot.binding.kind ||
      operation.deadline <= snapshot.block.timestamp ||
      operation.deadline > snapshot.expiresAt ||
      operation.deadline - snapshot.block.timestamp > snapshot.maxDeadlineDelay
    )
      throw new Error('Simulation snapshot mismatch.')
    const data = encodeStrategyEnvelope(operation, delegation)
    assertStrategyGrant({
      delegation,
      binding: snapshot.binding,
      executor,
      bindingEnforcer: snapshot.bindingEnforcer.address,
    })
    assertStrategyEnvelope(data, operation, executor)
    if ((await reader.getChainId()) !== 56) throw new Error('Simulation RPC chain mismatch.')
    const call = {
      account: executor,
      to: snapshot.manager,
      data,
      value: 0n,
      blockNumber: snapshot.block.number,
    } as const
    // A successful raw quote against the original pool is not proof of atomic LP replacement.
    await reader.call(call)
    const gasUnits = await reader.estimateGas(call),
      gasPriceWei = await reader.getGasPrice()
    if (
      typeof gasUnits !== 'bigint' ||
      gasUnits <= 0n ||
      gasUnits > 30_000_000n ||
      typeof gasPriceWei !== 'bigint' ||
      gasPriceWei <= 0n ||
      gasPriceWei > 1_000_000_000_000n
    )
      throw new Error('Invalid full-transaction gas estimate.')
    const block = (await reader.getBlock({ blockNumber: snapshot.block.number })) as {
      number?: unknown
      hash?: unknown
      timestamp?: unknown
    } | null
    if (
      !block ||
      block.number !== snapshot.block.number ||
      block.hash !== snapshot.block.hash ||
      block.timestamp !== snapshot.block.timestamp ||
      (await reader.getChainId()) !== 56
    )
      throw new Error('Simulation block changed.')
    const quote: StrategySimulationQuote = Object.freeze({
      [verified]: true as const,
      status: 'simulated',
      path: 'manager-delegation',
      blockNumber: snapshot.block.number,
      blockHash: snapshot.block.hash,
      operationDigest: strategyOperationDigest(operation),
      envelopeHash: keccak256(data),
      gasUnits,
      gasPriceWei,
    })
    issuedQuotes.add(quote)
    return quote
  } catch {
    return {
      status: 'blocked',
      reason:
        'The complete strategy transaction could not be simulated on the verified snapshot block.',
    }
  }
}
