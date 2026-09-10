import type { StrategyOperation } from './operation.js'

/** Admission reads only a previously verified persisted snapshot, never a caller's pre-state. */
export function operationMatchesStoredSnapshot(
  operation: StrategyOperation,
  raw: unknown,
): boolean {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const s = raw as Record<string, unknown>
    const integer = (value: unknown): bigint => {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
        throw new Error('Invalid snapshot integer')
      const result = BigInt(value)
      if (result >= 1n << 256n) throw new Error('Snapshot integer overflow')
      return result
    }
    const block = s.block as Record<string, unknown>,
      state = s.state as Record<string, unknown>
    const timestamp = integer(block.timestamp)
    if (
      s.paused !== false ||
      integer(s.nonce) !== operation.expectedNonce ||
      state.kind !== operation.kind ||
      operation.deadline <= timestamp ||
      operation.deadline > integer(s.expiresAt) ||
      operation.deadline - timestamp > integer(s.maxDeadlineDelay) ||
      (integer(s.lastExecutionAt) > 0n &&
        integer(s.lastExecutionAt) + integer(s.minInterval) > timestamp)
    )
      return false
    if (operation.kind === 'lp')
      return state.enrolled === true && integer(state.currentTokenId) === operation.expectedTokenId
    if (operation.kind === 'grid') {
      if (state.baselineRequired !== operation.baseline || !Array.isArray(state.rungs)) return false
      const rung = state.rungs.find((r: Record<string, unknown>) => r.index === operation.rungIndex)
      if (!rung?.state) return false
      const before = rung.state as Record<string, unknown>
      return (
        integer(before.inventory0) === operation.before.inventory0 &&
        integer(before.inventory1) === operation.before.inventory1 &&
        integer(before.cycle) === operation.before.cycle &&
        before.nextSell === operation.before.nextSell &&
        before.armed === operation.before.armed
      )
    }
    return true
  } catch {
    return false
  }
}
