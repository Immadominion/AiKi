import type { Measure } from '@aiki/contracts'
import { cn } from '@/lib/cn'
import { evidenceLabel, formatScore } from '@/lib/format'

/**
 * A score, drawn honestly.
 *
 * Confidence is NEVER a second number beside the value — users read two numbers as
 * two scores and average them. Instead confidence changes HOW the value is drawn:
 *
 *   1. precision clamps to it (89 → ≈90 → ≈90 → withheld entirely)
 *   2. an interval bar sits behind the numeral, its width the confidence interval
 *   3. the evidence count is stated in words, because non-experts reason about
 *      counts and "0.22 confidence" is noise to them
 *
 * Below 0.4 confidence no number is shown at all. Withholding is a designed state,
 * not a failure — Steam and Rotten Tomatoes both refuse to score under a threshold
 * and users accept "we won't guess" far better than a hedged number.
 */
export function ProofScore({
  measure,
  size = 'md',
  showEvidence = true,
  className,
}: {
  measure: Measure
  size?: 'sm' | 'md' | 'lg'
  showEvidence?: boolean
  className?: string
}) {
  const { text, withheld } = formatScore(measure)
  const { confidence, interval } = measure

  const dims = {
    sm: { num: 16, label: 10.5, bar: 3 },
    md: { num: 26, label: 11.5, bar: 4 },
    lg: { num: 44, label: 13, bar: 6 },
  }[size]

  // Interval as a proportion of the 0-100 scale, so a wide band reads as wide.
  const lo = interval?.[0] ?? measure.value
  const hi = interval?.[1] ?? measure.value

  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-baseline gap-2">
        <span
          className="tnum font-extrabold leading-none tracking-tight"
          style={{
            fontSize: dims.num,
            color: withheld ? 'var(--color-grey-400)' : 'var(--color-ink)',
          }}
        >
          {text}
        </span>
        {withheld && (
          <span className="text-xs font-medium text-grey-500">not enough evidence yet</span>
        )}
      </div>

      {!withheld && interval && (
        <div
          className="relative mt-1.5 w-full overflow-hidden rounded-full"
          style={{ height: dims.bar, background: 'var(--color-muted-bg)' }}
          role="img"
          aria-label={`range ${lo.toFixed(0)} to ${hi.toFixed(0)}`}
        >
          <span
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${Math.max(0, lo)}%`,
              width: `${Math.max(1.5, hi - lo)}%`,
              background: confidence >= 0.85 ? 'var(--color-ink)' : 'var(--color-grey-300)',
            }}
          />
        </div>
      )}

      {showEvidence && (
        <div className="mt-1.5 font-medium text-grey-500" style={{ fontSize: dims.label }}>
          {evidenceLabel(measure)}
        </div>
      )}
    </div>
  )
}
