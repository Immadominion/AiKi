import { ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import {
  GridStrategyVaultAbi,
  PancakeLPVaultAbi,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import {
  type Abi,
  type AbiEvent,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  keccak256,
} from 'viem'
import { vi } from 'vitest'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { encodeStrategyEnvelope } from './envelope.js'
import {
  encodeStrategyBindingTerms,
  encodeStrategyExpiryTerms,
  STRATEGY_EXPIRY_ENFORCER,
} from './grant.js'
import { STRATEGY_KIND_HASH, type StrategyOperation, strategyPlanHash } from './operation.js'
import {
  type StrategyReceiptReader,
  type StrategyReceiptTarget,
  verifyStrategyReceipt,
} from './receipt.js'

export const h = (byte: string) => `0x${byte.repeat(32)}` as Hex
export const a = (byte: string) => `0x${byte.repeat(20)}` as Hex
export const CODE = '0x60006000' as Hex
export const base = {
  binding: {
    version: 1,
    chainId: 56,
    kind: 'yield',
    vault: a('11'),
    controller: a('22'),
    policyHash: h('33'),
    runtimeCodeHash: keccak256(CODE),
  },
  expectedNonce: 7n,
  deadline: 1_900_000_000n,
} as const
export const yieldOp: Extract<StrategyOperation, { kind: 'yield' }> = {
  ...base,
  kind: 'yield',
  source: 0,
  destination: 1,
  assets: 100n,
  minReceived: 98n,
}
export const gridOp: Extract<StrategyOperation, { kind: 'grid' }> = {
  ...base,
  binding: { ...base.binding, kind: 'grid' },
  kind: 'grid',
  rungIndex: 0,
  baseline: false,
  before: { inventory0: 100n, inventory1: 50n, cycle: 0n, nextSell: true, armed: true },
}
export const lpOp: Extract<StrategyOperation, { kind: 'lp' }> = {
  ...base,
  binding: { ...base.binding, kind: 'lp' },
  kind: 'lp',
  expectedTokenId: 42n,
  tickLower: -100,
  tickUpper: 100,
  zeroForOne: true,
  swapAmount: 10n,
  minSwapOut: 8n,
  sqrtPriceLimitX96: 1n << 95n,
  minBurn0: 1n,
  minBurn1: 1n,
  minMint0: 1n,
  minMint1: 1n,
  minLiquidity: 100n,
}

export function fixture(
  operation: StrategyOperation = yieldOp,
  gridFilled = true,
  executor = a('66'),
) {
  const delegation = {
    delegate: executor,
    delegator: operation.binding.controller,
    authority: ROOT_AUTHORITY,
    caveats: [
      {
        enforcer: STRATEGY_EXPIRY_ENFORCER.address,
        terms: encodeStrategyExpiryTerms(operation.deadline + 86400n),
        args: '0x' as Hex,
      },
      {
        enforcer: a('34'),
        terms: encodeStrategyBindingTerms(operation.binding),
        args: '0x' as Hex,
      },
    ],
    salt: 1n,
    epoch: 0n,
    // Structural signature only. This mocked read-only fixture does not authenticate an owner.
    signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}11b` as Hex,
  }
  const input = encodeStrategyEnvelope(operation, delegation)
  const target: StrategyReceiptTarget = {
    operation,
    transactionHash: h('44'),
    manager: mainnet.manager as Hex,
    executor,
    envelopeHash: keccak256(input),
  }
  const receipt: Record<string, unknown> = {
    transactionHash: target.transactionHash,
    blockHash: h('77'),
    blockNumber: 100n,
    status: 'success',
    logs: [],
  }
  const tx: Record<string, unknown> = {
    hash: target.transactionHash,
    to: target.manager,
    from: target.executor,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    value: 0n,
    input,
  }
  const finalized: Record<string, unknown> = { number: 110n, hash: h('88') }
  const canonical: Record<string, unknown> = { number: 100n, hash: receipt.blockHash }
  const reader = {
    getChainId: vi.fn(async () => 56),
    getTransactionReceipt: vi.fn(async () => receipt),
    getTransaction: vi.fn(async () => tx),
    getBlock: vi.fn(async (input: { blockTag: 'finalized' } | { blockNumber: bigint }) =>
      'blockTag' in input ? finalized : canonical,
    ),
    getBytecode: vi.fn(async () => CODE as Hex | undefined),
    readContract: vi.fn(
      async (input: Parameters<StrategyReceiptReader['readContract']>[0]): Promise<unknown> =>
        input.functionName === 'controller'
          ? operation.binding.controller
          : input.functionName === 'policyHash'
            ? operation.binding.policyHash
            : STRATEGY_KIND_HASH[operation.kind],
    ),
  } satisfies StrategyReceiptReader
  const abi: Abi =
    operation.kind === 'yield'
      ? YieldAllocationVaultAbi
      : operation.kind === 'grid'
        ? GridStrategyVaultAbi
        : PancakeLPVaultAbi
  let index = 0
  function event(name: string, args: Record<string, unknown>) {
    const definition = abi.find((item) => item.type === 'event' && item.name === name) as AbiEvent
    const dataInputs = definition.inputs.filter((input) => !input.indexed)
    return {
      address: operation.binding.vault,
      transactionHash: target.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      removed: false,
      logIndex: index++,
      topics: encodeEventTopics({ abi: [definition], eventName: name, args }),
      data: encodeAbiParameters(
        dataInputs,
        dataInputs.map((input) => args[input.name ?? '']),
      ),
    }
  }
  const complete = (
    planHash = strategyPlanHash(
      operation,
      operation.kind === 'grid' ? { spot: 100, twap: 95, baseline: operation.baseline } : undefined,
    ),
  ) => event('StrategyExecuted', { policyHash: operation.binding.policyHash, nonce: 8n, planHash })
  let result: Record<string, unknown>
  let logs: ReturnType<typeof event>[]
  if (operation.kind === 'yield') {
    result = {
      nonce: 8n,
      source: operation.source,
      destination: operation.destination,
      requestedAssets: 100n,
      movedAssets: 99n,
      assetsBefore: 110n,
      assetsAfter: 109n,
      loss: 1n,
      idle: 10n,
      venusShares: 99n,
      aaveScaled: 0n,
    }
    logs = [event('YieldMoved', result), complete()]
  } else if (operation.kind === 'lp') {
    result = {
      policyHash: operation.binding.policyHash,
      nonce: 8n,
      oldTokenId: 42n,
      newTokenId: 43n,
      liquidity: 110n,
      amountIn: operation.swapAmount === 0n ? 0n : 9n,
      amountOut: operation.swapAmount === 0n ? 0n : 8n,
      lossQuote: 1n,
      idle0: 10n,
      idle1: 20n,
    }
    logs = [event('Rebalanced', result), complete()]
  } else {
    result = {
      operationNonce: 8n,
      rung: 0,
      cycle: 0n,
      soldToken0: operation.before.nextSell,
      actualInput: 10n,
      actualOutput: 9n,
      inventory0: operation.before.nextSell ? 90n : 109n,
      inventory1: operation.before.nextSell ? 59n : 40n,
    }
    const observed = event('GridObserved', {
      operationNonce: 8n,
      spot: 100,
      twap: 95,
      baseline: operation.baseline,
    })
    logs = [...(gridFilled ? [event('GridFilled', result)] : []), observed, complete()]
  }
  receipt.logs = logs
  return {
    delegation,
    target,
    reader,
    receipt,
    tx,
    finalized,
    canonical,
    result,
    event,
    complete,
    logs,
    run: () => verifyStrategyReceipt(target, reader),
  }
}
