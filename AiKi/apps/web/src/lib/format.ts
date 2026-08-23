/**
 * Display helpers that encode the design brief's honesty rules.
 * These are shared so the rules cannot drift between components.
 */

import type { Measure } from '@aiki/contracts'

/**
 * Precision as an uncertainty channel.
 *
 * The number of digits printed IS a claim about how much we know. Rendering
 * "95.3" at 0.22 confidence is a lie told in typography. The US National Weather
 * Service issues precipitation probability only in 10% increments for exactly
 * this reason. Free to implement, and nobody in crypto does it.
 */
export function formatScore(m: Measure): { text: string; withheld: boolean } {
  const { value, confidence } = m
  if (confidence < 0.4) return { text: 'n/a', withheld: true }
  if (confidence >= 0.85) return { text: value.toFixed(0), withheld: false }
  if (confidence >= 0.6)
    return { text: `≈${(Math.round(value / 5) * 5).toFixed(0)}`, withheld: false }
  return { text: `≈${(Math.round(value / 10) * 10).toFixed(0)}`, withheld: false }
}

/** Evidence as a count, not a probability — non-experts reason about counts. */
export function evidenceLabel(m: Measure): string {
  if (m.sampleSize === 0) return 'no observations yet'
  return `${m.sampleSize.toLocaleString()} observation${m.sampleSize === 1 ? '' : 's'}`
}

/** Truncate an address. EVM hex has no O/I/l — the real confusables are 8/B, 5/S. */
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export const pct = (n: number, total: number) =>
  total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`
