import type { Measure, Provenance } from '@aiki/contracts'

/**
 * Wilson score interval.
 *
 * The reason we never show a raw success ratio: 4 successes out of 4 and 171 out
 * of 174 are both "100%" and "98%" to a naive ratio, and the first tells you
 * almost nothing. Wilson's lower bound collapses toward 0.5 as the sample thins,
 * so a perfect 4-for-4 lands near 51 while 171-of-174 lands near 95.
 *
 * z is pinned rather than tuned, and recorded in `method`, so a score can always
 * be recomputed from the counts that produced it.
 */
export const Z = 1.96

export interface Interval {
  lower: number
  upper: number
  point: number
}

export function wilson(successes: number, trials: number, z = Z): Interval {
  if (trials <= 0) return { lower: 0, upper: 1, point: 0 }
  const p = successes / trials
  const z2 = z * z
  const denom = 1 + z2 / trials
  const centre = p + z2 / (2 * trials)
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
    point: p,
  }
}

/**
 * Confidence is derived from how wide the interval is, never hand-assigned.
 *
 * A tight interval means the evidence pins the value down; a wide one means it
 * does not, whatever the point estimate happens to be. Everything downstream —
 * how many digits we print, whether we print a number at all — reads this.
 */
export const confidenceFrom = (i: Interval) => Math.max(0, Math.min(1, 1 - (i.upper - i.lower)))

/** Build a contract `Measure` from the counts behind it, so the two cannot drift. */
export function measureFrom(
  successes: number,
  trials: number,
  provenance: Provenance,
  z = Z,
): Measure {
  const i = wilson(successes, trials, z)
  return {
    value: i.lower * 100,
    confidence: confidenceFrom(i),
    interval: [i.lower * 100, i.upper * 100],
    sampleSize: trials,
    method: `wilson-lb;z=${z}`,
    provenance,
  }
}

/**
 * Wilson interval from a rate rather than a count.
 *
 * Only for projections — "how much more evidence would we need" — where the
 * successes are hypothetical. Rounding a rate back into whole successes makes
 * the effective rate jitter with every n, and the interval width jitters with
 * it, which is how you end up reporting a knife-edge answer that flips the
 * moment one more check lands.
 */
export function wilsonRate(rate: number, trials: number, z = Z): Interval {
  if (trials <= 0) return { lower: 0, upper: 1, point: rate }
  const z2 = z * z
  const denom = 1 + z2 / trials
  const centre = rate + z2 / (2 * trials)
  const margin = z * Math.sqrt((rate * (1 - rate)) / trials + z2 / (4 * trials * trials))
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
    point: rate,
  }
}

/** Our own probes, observed directly. Class B — the only class we fully control. */
export const aikiProbe = (observedAt: string): Provenance => ({
  source: 'aiki:prober',
  method: 'capability-probe/v2',
  observedAt,
  evidenceClass: 'B',
})
