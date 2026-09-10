import { encodeAbiParameters, type Hex, keccak256, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { strategyRunnerReadinessDigest } from './runner-readiness.js'

const deployment = `0x${'ab'.repeat(32)}` as Hex,
  executor = `0x${'cd'.repeat(20)}` as Hex

describe('executor-bound strategy readiness identity', () => {
  it('commits the explicit readiness domain, chain 56, deployment and canonical executor', () => {
    expect(strategyRunnerReadinessDigest(deployment, executor)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }],
          [keccak256(stringToHex('aiki.strategy-runner.readiness.v1')), 56n, deployment, executor],
        ),
      ),
    )
    expect(strategyRunnerReadinessDigest(deployment, executor)).toBe(
      strategyRunnerReadinessDigest(
        `0x${deployment.slice(2).toUpperCase()}`,
        `0x${executor.slice(2).toUpperCase()}`,
      ),
    )
  })
  it('does not reuse a legacy deployment hash or a different configuration or executor', () => {
    const ready = strategyRunnerReadinessDigest(deployment, executor)
    expect(ready).not.toBe(deployment)
    expect(ready).not.toBe(strategyRunnerReadinessDigest(`0x${'ef'.repeat(32)}`, executor))
    expect(ready).not.toBe(strategyRunnerReadinessDigest(deployment, `0x${'ef'.repeat(20)}`))
  })
  it.each([undefined, null, '0x', `0x${'00'.repeat(32)}`, 'not-a-hash'])(
    'rejects invalid deployment identity %s',
    (invalid) => {
      expect(() => strategyRunnerReadinessDigest(invalid as Hex, executor)).toThrow(
        'Strategy readiness identity is unavailable.',
      )
    },
  )
  it.each([undefined, null, '0x', `0x${'00'.repeat(20)}`, 'not-an-address'])(
    'rejects invalid executor identity %s',
    (invalid) => {
      expect(() => strategyRunnerReadinessDigest(deployment, invalid as Hex)).toThrow(
        'Strategy readiness identity is unavailable.',
      )
    },
  )
})
