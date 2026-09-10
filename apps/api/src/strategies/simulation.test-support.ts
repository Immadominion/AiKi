import { vi } from 'vitest'
import type { SignedDelegation } from '../execution/executor.js'
import type { StrategyOperation } from './operation.js'
import { a } from './receipt.test-support.js'
import { quoteStrategyOperation, type StrategySimulationReader } from './simulation.js'
import type { VerifiedStrategySnapshot } from './snapshot.js'
import { snapshotFixture } from './snapshot.test-support.js'

export async function simulationFixture(
  operation: StrategyOperation,
  delegation: SignedDelegation,
  supplied?: VerifiedStrategySnapshot,
) {
  const fixture = snapshotFixture(operation.kind, {
    binding: operation.binding,
    owner: a('99'),
    nonce: operation.expectedNonce,
    timestamp: operation.deadline - 120n,
    expiresAt: operation.deadline - 120n + 86400n,
    managerCode: '0x60006000',
    vaultCode: '0x60006000',
    blockNumber: 99n,
  })
  const verified = supplied
    ? { status: 'verified' as const, snapshot: supplied }
    : await fixture.run()
  if (verified.status !== 'verified') throw new Error('Invalid simulation snapshot fixture')
  const snapshot = verified.snapshot
  const reader = {
    getChainId: vi.fn(async () => 56),
    getGasPrice: vi.fn(async () => 50_000_000n),
    call: vi.fn(async (_input: Parameters<StrategySimulationReader['call']>[0]) => ({
      data: '0x',
    })),
    estimateGas: vi.fn(
      async (_input: Parameters<StrategySimulationReader['estimateGas']>[0]) => 100_000n,
    ),
    getBlock: vi.fn(
      async (_input: Parameters<StrategySimulationReader['getBlock']>[0]) => snapshot.block,
    ),
  } satisfies StrategySimulationReader
  const input = { operation, delegation, executor: delegation.delegate, snapshot, reader }
  const result = await quoteStrategyOperation(input)
  if (result.status !== 'simulated') throw new Error('Invalid simulation fixture')
  return { simulation: result, snapshot, reader, input, run: () => quoteStrategyOperation(input) }
}
