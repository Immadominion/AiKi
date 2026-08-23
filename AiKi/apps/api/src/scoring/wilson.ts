/** Pinned z=1.96; scores are confidence bounds, never raw success ratios. */
export const SCORING_VERSION = 'wilson-lb/v1;z=1.96'
export function wilson(successes: number, trials: number, z = 1.96) {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(trials) ||
    successes < 0 ||
    trials < successes
  )
    throw new Error('Invalid Bernoulli sample.')
  if (trials === 0) return { lower: 0, upper: 1, confidence: 0 }
  const p = successes / trials
  const z2 = z * z
  const d = 1 + z2 / trials
  const center = (p + z2 / (2 * trials)) / d
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / d
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    confidence: 1 - Math.min(1, 2 * margin),
  }
}
