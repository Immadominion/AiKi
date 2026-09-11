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

/** Evidence as a count, not a probability - non-experts reason about counts. */
export function evidenceLabel(m: Measure): string {
  if (m.sampleSize === 0) return 'no observations yet'
  return `${m.sampleSize.toLocaleString()} observation${m.sampleSize === 1 ? '' : 's'}`
}

/** Truncate an address. EVM hex has no O/I/l - the real confusables are 8/B, 5/S. */
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export const pct = (n: number, total: number) =>
  total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`

/**
 * Base units to something a person reads, without ever touching a float.
 *
 * A balance arrives as an integer string because that is what it is on chain,
 * and `Number(raw) / 10 ** decimals` silently loses precision above about nine
 * quadrillion base units, which an eighteen-decimal token reaches at ten of
 * itself. So the split is done on the digits and the remainder is trimmed for
 * display only, never rounded up: showing more than somebody has is the one
 * error a balance must not make.
 */
export function formatUnits(raw: string, decimals: number, maxFractionDigits = 4): string {
  if (!/^\d+$/.test(raw)) return '0'
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals) || '0'
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (decimals === 0 || maxFractionDigits === 0) return grouped
  const fraction = padded.slice(padded.length - decimals).slice(0, maxFractionDigits)
  const trimmed = fraction.replace(/0+$/, '')
  if (trimmed) return `${grouped}.${trimmed}`
  /*
   * A balance too small to show at this precision is not zero, and printing it
   * as zero is the same lie as printing an unreadable balance as zero. Say it is
   * under the smallest amount this many digits can express.
   */
  if (whole === '0' && !/^0*$/.test(raw)) return `<0.${'0'.repeat(maxFractionDigits - 1)}1`
  return grouped
}

/** True when a balance is exactly nothing, so copy can say so rather than "0". */
export const isZeroAmount = (raw: string) => /^0*$/.test(raw)
