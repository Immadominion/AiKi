import { describe, expect, it } from 'vitest'
import type { StrategyOperation } from './operation.js'
import { gridOp, lpOp, yieldOp } from './receipt.test-support.js'
import { operationMatchesStoredSnapshot } from './stored-state.js'

const json = (value: unknown): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  )

// This predicate consumes already verified/persisted state. Store admission independently
// checks the complete binding, canonical block identity, owner and persisted-snapshot age.
function stored(operation: StrategyOperation) {
  const timestamp = operation.deadline - 120n
  return json({
    binding: operation.binding,
    block: { chainId: 56, number: 100n, hash: `0x${'aa'.repeat(32)}`, timestamp },
    paused: false,
    nonce: operation.expectedNonce,
    expiresAt: operation.deadline + 1000n,
    maxDeadlineDelay: 120n,
    lastExecutionAt: timestamp - 60n,
    minInterval: 60n,
    state:
      operation.kind === 'lp'
        ? { kind: 'lp', enrolled: true, currentTokenId: operation.expectedTokenId }
        : operation.kind === 'grid'
          ? {
              kind: 'grid',
              baselineRequired: operation.baseline,
              rungs: [{ index: operation.rungIndex, state: operation.before }],
            }
          : { kind: 'yield' },
  })
}

describe('durable snapshot admission predicate', () => {
  it.each([yieldOp, gridOp, lpOp])('matches an exact persisted $kind checkpoint', (operation) => {
    expect(operationMatchesStoredSnapshot(operation, stored(operation))).toBe(true)
  })
  it.each([null, [], {}, true, 'snapshot'])(
    'fails closed for absent or malformed stored evidence %#',
    (raw) => {
      expect(operationMatchesStoredSnapshot(yieldOp, raw)).toBe(false)
    },
  )
  it.each([
    ['paused', true],
    ['paused', 'false'],
    ['nonce', '8'],
    ['nonce', 7],
    ['nonce', '07'],
    ['nonce', '-1'],
    ['nonce', (1n << 256n).toString()],
    ['maxDeadlineDelay', '119'],
    ['expiresAt', (yieldOp.deadline - 1n).toString()],
    ['lastExecutionAt', (yieldOp.deadline - 179n).toString()],
    ['minInterval', '61'],
    ['block', null],
    ['state', null],
  ])('refuses changed or noncanonical lifecycle field %s', (key, value) => {
    expect(
      operationMatchesStoredSnapshot(yieldOp, { ...stored(yieldOp), [String(key)]: value }),
    ).toBe(false)
  })
  it('requires deadline strictly after the snapshot and checks cooldown against that block', () => {
    const raw = stored(yieldOp)
    const block = raw.block as Record<string, unknown>
    block.timestamp = yieldOp.deadline.toString()
    expect(operationMatchesStoredSnapshot(yieldOp, raw)).toBe(false)
    raw.lastExecutionAt = '0'
    block.timestamp = (yieldOp.deadline - 1n).toString()
    expect(operationMatchesStoredSnapshot(yieldOp, raw)).toBe(true)
  })
  it('preserves LP NFT identity and refuses owner-recovered or unenrolled state', () => {
    const operation = { ...lpOp, expectedTokenId: (1n << 200n) + 42n }
    const raw = stored(operation),
      state = raw.state as Record<string, unknown>
    expect(operationMatchesStoredSnapshot(operation, raw)).toBe(true)
    for (const changed of [
      { currentTokenId: '42' },
      { currentTokenId: '0' },
      { currentTokenId: Number(operation.expectedTokenId) },
      { enrolled: false },
      { enrolled: 'true' },
      { kind: 'yield' },
    ])
      expect(
        operationMatchesStoredSnapshot(operation, { ...raw, state: { ...state, ...changed } }),
      ).toBe(false)
  })
  it('requires the exact Grid baseline and selected rung, not an adjacent inventory', () => {
    const raw = stored(gridOp),
      state = raw.state as Record<string, unknown>
    for (const changed of [
      { baselineRequired: true },
      { baselineRequired: 'false' },
      { rungs: [] },
      { rungs: [{ index: 1, state: json(gridOp.before) }] },
      { rungs: [{ index: '0', state: json(gridOp.before) }] },
      { rungs: null },
    ])
      expect(
        operationMatchesStoredSnapshot(gridOp, { ...raw, state: { ...state, ...changed } }),
      ).toBe(false)
  })
  it.each([
    ['inventory0', '101'],
    ['inventory1', '51'],
    ['cycle', '1'],
    ['cycle', 0],
    ['inventory0', '0100'],
    ['nextSell', false],
    ['armed', false],
    ['armed', 'true'],
  ])('requires exact Grid pre-state %s', (key, value) => {
    const raw = stored(gridOp),
      state = raw.state as Record<string, unknown>
    state.rungs = [{ index: 0, state: { ...json(gridOp.before), [String(key)]: value } }]
    expect(operationMatchesStoredSnapshot(gridOp, raw)).toBe(false)
  })
  it('accepts large exact Grid inventories and does not mutate persisted state', () => {
    const operation = {
      ...gridOp,
      before: {
        ...gridOp.before,
        inventory0: (1n << 200n) + 1n,
        inventory1: (1n << 256n) - 1n,
        cycle: (1n << 64n) - 1n,
      },
    }
    const raw = stored(operation),
      before = structuredClone(raw)
    expect(operationMatchesStoredSnapshot(operation, raw)).toBe(true)
    expect(raw).toEqual(before)
  })
})
