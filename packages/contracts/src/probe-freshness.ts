import type { LivenessState, Timestamp } from './types.js'

/** A recheck threshold, not a promise that every registration is checked daily. */
export const PROBE_FRESHNESS_MAX_AGE_MS = 24 * 60 * 60 * 1_000

export interface ProbeFreshness {
  state: 'LIVE' | 'STALE' | 'NO_DATA'
  checkedAt: Timestamp | null
  expiresAt: Timestamp | null
  ageMs: number | null
}

/** Historical verdicts remain unchanged when their evidence stops being current. */
export function probeFreshness(
  lastProbeAt: string | null | undefined,
  nowMs = Date.now(),
): ProbeFreshness {
  if (lastProbeAt == null)
    return { state: 'NO_DATA', checkedAt: null, expiresAt: null, ageMs: null }
  const checkedMs = Date.parse(lastProbeAt)
  if (!Number.isFinite(checkedMs) || !Number.isFinite(nowMs) || checkedMs > nowMs)
    return { state: 'STALE', checkedAt: lastProbeAt, expiresAt: null, ageMs: null }
  const ageMs = nowMs - checkedMs
  const expiresMs = checkedMs + PROBE_FRESHNESS_MAX_AGE_MS
  return {
    state: ageMs <= PROBE_FRESHNESS_MAX_AGE_MS ? 'LIVE' : 'STALE',
    checkedAt: lastProbeAt,
    expiresAt:
      Number.isFinite(expiresMs) && Math.abs(expiresMs) <= 8.64e15
        ? new Date(expiresMs).toISOString()
        : null,
    ageMs,
  }
}

/** Recompute from evidence time, so cached freshness flags cannot extend eligibility. */
export function hasCurrentLiveness(
  passport: { liveness: string; lastProbeAt?: string | null | undefined },
  allowedStates: readonly LivenessState[] = ['LIVE'],
  nowMs = Date.now(),
): boolean {
  return (
    allowedStates.some((state) => state === passport.liveness) &&
    probeFreshness(passport.lastProbeAt, nowMs).state === 'LIVE'
  )
}
