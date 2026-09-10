import { keccak256 } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { decodeYieldRunnerState } from './runner-plan.js'
import {
  createStrategyRunnerPolicy,
  parseStrategyRunnerPolicy,
  strategyJSON,
} from './runner-policy.js'
import { snapshotFixture } from './snapshot.test-support.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x6005') } }
})
async function snapshot(kind: 'yield' | 'grid' | 'lp') {
  const result = await snapshotFixture(kind).run()
  if (result.status !== 'verified') throw new Error('Invalid test snapshot')
  return result.snapshot
}
describe('reviewed strategy runner policy', () => {
  it.each(['yield', 'grid', 'lp'] as const)(
    'roundtrips %s without reviving arbitrary JSON',
    async (kind) => {
      const proof = await snapshot(kind),
        pins = { poolRuntimeCodeHash: keccak256('0x6004') }
      const policy = createStrategyRunnerPolicy(proof, 10n ** 14n, pins)
      const stored = JSON.parse(strategyJSON(policy))
      expect(parseStrategyRunnerPolicy(stored, proof, 10n ** 14n, pins)).toEqual(policy)
      stored.version = 2
      expect(() => parseStrategyRunnerPolicy(stored, proof, 10n ** 14n, pins)).toThrow(
        'reviewed version',
      )
    },
  )
  it('cannot relax gas, immutable limits or service freshness by editing saved JSON', async () => {
    const proof = await snapshot('grid'),
      policy = createStrategyRunnerPolicy(proof, 10n ** 14n)
    for (const [key, value] of [
      ['maxGasCostWei', '10000000000000000'],
      ['maxSnapshotAgeSeconds', 3600],
      ['extra', true],
    ]) {
      const stored = JSON.parse(strategyJSON(policy))
      stored.planner[key as string] = value
      expect(() => parseStrategyRunnerPolicy(stored, proof, 10n ** 14n)).toThrow()
    }
  })
  it('requires an opaque verified snapshot, not its JSON copy', async () => {
    const proof = await snapshot('yield')
    expect(() => createStrategyRunnerPolicy({ ...proof }, 10n ** 14n)).toThrow('verified vault')
  })
  it.each([0n, -1n, 10n ** 15n + 1n])('rejects gas ceiling %s', async (gas) => {
    const proof = await snapshot('yield')
    expect(() => createStrategyRunnerPolicy(proof, gas)).toThrow()
  })
  it('requires a reviewed LP pool runtime hash', async () => {
    const proof = await snapshot('lp')
    expect(() => createStrategyRunnerPolicy(proof, 10n ** 14n)).toThrow('reviewed runtime')
  })
  it('includes the actual immutable yield limits and a finite reviewed horizon', async () => {
    const proof = await snapshot('yield'),
      policy = createStrategyRunnerPolicy(proof, 10n ** 14n)
    expect(policy).toMatchObject({
      kind: 'yield',
      planner: {
        limits: proof.state.kind === 'yield' ? proof.state.limits : {},
        horizonSeconds: 2592000,
        requiredObservations: 2,
      },
    })
  })
  it('normalizes JSONB object ordering but preserves array order', () => {
    expect(strategyJSON({ b: 2n, a: { d: 4n, c: 3n } })).toBe(
      strategyJSON({ a: { c: '3', d: '4' }, b: '2' }),
    )
    expect(strategyJSON([1, 2])).not.toBe(strategyJSON([2, 1]))
  })
})
describe('yield observation checkpoint codec', () => {
  const observation = {
    blockNumber: '100',
    blockHash: keccak256('0x01'),
    timestamp: 1900000000,
    candidate: 'idle:venus',
    count: 1,
    nonce: '7',
  }
  it('starts empty and revives only canonical observational fields', () => {
    expect(decodeYieldRunnerState({})).toEqual({})
    expect(decodeYieldRunnerState({ lastObservation: observation })).toEqual({
      lastObservation: { ...observation, blockNumber: 100n, nonce: 7n },
    })
  })
  it.each([
    null,
    [],
    { pendingNonce: '7' },
    { lastObservation: { ...observation, nonce: 7 } },
    { lastObservation: { ...observation, blockNumber: '01' } },
    { lastObservation: { ...observation, count: 3 } },
    { lastObservation: { ...observation, candidate: 'venus:venus' } },
    { lastObservation: { ...observation, extra: true } },
    { lastObservation: { ...observation, blockHash: '0x' } },
    { lastObservation: { ...observation, timestamp: 1.5 } },
  ])('refuses malformed or executable checkpoint %j', (value) => {
    expect(() => decodeYieldRunnerState(value)).toThrow('Invalid yield observation')
  })
})
