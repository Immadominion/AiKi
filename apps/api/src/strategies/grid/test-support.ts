import { ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import type { Hex } from 'viem'
import { vi } from 'vitest'
import { encodeStrategyBindingTerms } from '../grant.js'
import type { GridPlannerPolicy } from '../grid-planner.js'
import type { StrategyOperation } from '../operation.js'
import { quoteStrategyOperation } from '../simulation.js'
import type { VerifiedStrategySnapshot } from '../snapshot.js'
import { snapshotFixture } from '../snapshot.test-support.js'
import { readGridMarketSnapshot } from './market.js'
import { sqrtRatioAtTick } from './math.js'

export const NOW = 1_900_000_000
export const a = (byte: string) => `0x${byte.repeat(20)}` as Hex
export const gasPolicy: GridPlannerPolicy = {
  maxSnapshotAgeSeconds: 120,
  deadlineSeconds: 60,
  maxGasUnits: 1_000_000n,
  maxGasPriceWei: 10n,
  maxGasCostWei: 10_000_000n,
  gasBufferBps: 2000,
}
/** Test-only responses pass through the production snapshot and market proof issuers. */
export function gridFixture(spot = 0, twap = spot) {
  const f = snapshotFixture('grid')
  const pool = a('83'),
    vault = f.target.binding.vault
  f.set(pool, 'slot0', [sqrtRatioAtTick(spot), spot, 0, 2, 2, 0, true])
  f.set(pool, 'liquidity', 1000n)
  f.set(pool, 'observations', [NOW - 600, 0n, 0n, true], [1])
  const delta = (300n * ((1n << 160n) - 1n)) / (1000n << 32n)
  f.set(
    pool,
    'observe',
    [
      [0n, BigInt(twap) * 300n],
      [0n, delta],
    ],
    [[300, 0]],
  )
  f.set(a('71'), 'allowance', 0n, [vault, a('81')])
  f.set(a('72'), 'allowance', 0n, [vault, a('81')])
  const rung = (index: number, values: Record<string, unknown>) =>
    f.setVault(
      'rungState',
      {
        ...(f.values.get(f.key(vault, 'rungState', [index])) as Record<string, unknown>),
        ...values,
      },
      [index],
    )
  const policy = (values: Record<string, unknown>) =>
    f.setVault('gridPolicy', {
      ...(f.values.get(f.key(vault, 'gridPolicy')) as Record<string, unknown>),
      ...values,
    })
  const snapshot = async () => {
    const result = await f.run()
    if (result.status !== 'verified') throw new Error('Invalid snapshot fixture')
    return result.snapshot
  }
  const evidence = async () => {
    const s = await snapshot()
    const result = await readGridMarketSnapshot(s, f.reader)
    if (result.status !== 'verified') throw new Error('Invalid market fixture')
    return { snapshot: s, market: result.market }
  }
  return { ...f, pool, rung, policy, snapshot, evidence }
}
export function simulationFixture(snapshot: VerifiedStrategySnapshot) {
  const reader = {
    getChainId: vi.fn(async () => 56),
    getGasPrice: vi.fn(async () => 2n),
    call: vi.fn(async () => ({ data: '0x' as Hex })),
    estimateGas: vi.fn(async () => 100000n),
    getBlock: vi.fn(async () => ({
      number: snapshot.block.number,
      hash: snapshot.block.hash,
      timestamp: snapshot.block.timestamp,
    })),
  }
  const simulate = vi.fn((operation: StrategyOperation) =>
    quoteStrategyOperation({
      operation,
      snapshot,
      executor: a('66'),
      reader,
      delegation: {
        delegate: a('66'),
        delegator: snapshot.binding.controller,
        authority: ROOT_AUTHORITY,
        caveats: [
          {
            enforcer: snapshot.bindingEnforcer.address,
            terms: encodeStrategyBindingTerms(snapshot.binding),
            args: '0x',
          },
        ],
        salt: 1n,
        epoch: 0n,
        // Structural-only fixture r=1, s=1, v=27; the manager call itself is mocked.
        signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}11b`,
      },
    }),
  )
  return { reader, simulate }
}
