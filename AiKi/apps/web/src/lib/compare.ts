import type { Measure } from '@aiki/contracts'
import type { Counts } from './detail'
import { wilson, wilsonRate, Z } from './measure'

/**
 * Two measures are indistinguishable when their intervals overlap.
 *
 * This is the single most important rule on the compare screen. Separating two
 * agents differing by half a Sharpe ratio needs decades of data; showing a
 * ranked list anyway is the standard dishonesty of every leaderboard. When the
 * ranges overlap we say we cannot tell, and then say what would settle it.
 */
export function overlaps(a: Measure, b: Measure): boolean {
  const [al, au] = a.interval ?? [a.value, a.value]
  const [bl, bu] = b.interval ?? [b.value, b.value]
  return al <= bu && bl <= au
}

export interface Separation {
  /** Checks the thinner agent needs, at its observed rate, before the ranges part. */
  checksNeeded: number | null
  /** Which way it would fall if the observed rate holds. */
  wouldLand: 'below' | 'above'
  observedRate: number
}

const MAX_N = 200_000

/**
 * How long the separation has to hold before we believe it.
 *
 * At the boundary a single extra check can push the intervals apart and the next
 * one can push them back together. Reporting the first n that happens to clear
 * would promise an answer in four more checks that four more checks would not
 * actually deliver. Requiring it to hold across a stretch of sample sizes costs
 * nothing and stops us quoting a coin flip.
 */
const MUST_HOLD_FOR = 12

/**
 * How much more evidence would settle it.
 *
 * Holds the thin agent's observed success rate fixed and grows the sample until
 * its interval clears the other's. That answers the question a user actually
 * has — "how long until you know?" — instead of the one a p-value answers.
 *
 * It returns null when the rate itself means the ranges will never part, which
 * is a real answer and a more useful one than a number.
 */
export function separation(thin: Counts, against: Measure): Separation {
  const [successes, trials] = thin
  const rate = trials > 0 ? successes / trials : 0
  const [otherLow, otherHigh] = against.interval ?? [against.value, against.value]

  const current = wilson(successes, trials, Z)
  const wouldLand: Separation['wouldLand'] =
    rate * 100 < (otherLow + otherHigh) / 2 ? 'below' : 'above'

  const clear = (n: number) => {
    const i = wilsonRate(rate, n, Z)
    return i.upper * 100 < otherLow || i.lower * 100 > otherHigh
  }

  for (let n = trials + 1; n <= MAX_N; n++) {
    if (!clear(n)) continue
    let holds = true
    for (let k = 1; k <= MUST_HOLD_FOR; k++) {
      if (!clear(n + k)) {
        holds = false
        break
      }
    }
    if (holds) return { checksNeeded: n - trials, wouldLand, observedRate: rate }
    n += MUST_HOLD_FOR
  }

  return { checksNeeded: null, wouldLand, observedRate: current.point }
}

/** Plain-language duration for a count of checks at an observed cadence. */
export function timeFor(checks: number, checksPerDay: number): string {
  const days = Math.ceil(checks / Math.max(checksPerDay, 0.01))
  if (days < 14) return `about ${days} days`
  if (days < 90) return `about ${Math.round(days / 7)} weeks`
  if (days < 730) return `about ${Math.round(days / 30)} months`
  return `about ${Math.round(days / 365)} years`
}
