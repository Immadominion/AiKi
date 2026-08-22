import type { Measure } from '@aiki/contracts'
import { formatScore } from '@/lib/format'

/**
 * The proof score, drawn so the uncertainty is impossible to miss.
 *
 * Confidence never appears as a second number beside the score — people read two
 * numbers as two scores and average them. It changes how the score is DRAWN:
 * the digits are clamped, and the interval is shown as a band the true value
 * lies somewhere inside. Below 0.4 confidence there is no number at all.
 */
export function ScoreBlock({
  measure,
  label,
  note,
}: {
  measure: Measure
  label: string
  note: string
}) {
  const { text, withheld } = formatScore(measure)
  const [lo, hi] = measure.interval ?? [measure.value, measure.value]

  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] p-[18px]">
      <div className="text-muted text-[12.5px] font-semibold">{label}</div>

      <div className="mt-[6px] flex items-end gap-[10px]">
        <span
          className="text-[54px] leading-[0.9] font-extrabold tracking-[-0.04em] tabular-nums"
          style={{ color: withheld ? 'var(--color-faint)' : 'var(--color-ink-app)' }}
        >
          {text}
        </span>
        {!withheld && <span className="text-muted mb-[6px] text-[15px] font-semibold">/ 100</span>}
      </div>

      {/* The band is the answer. The tick is only where the band starts. */}
      <div className="mt-[18px]">
        <div className="relative h-[10px] w-full overflow-hidden rounded-full bg-[rgb(26_26_25_/_0.06)]">
          <span
            className="absolute inset-y-0 rounded-full bg-[rgb(255_90_0_/_0.22)]"
            style={{ left: `${lo}%`, width: `${Math.max(hi - lo, 0.6)}%` }}
          />
          <span
            className="bg-orange-app absolute inset-y-0 w-[2px] rounded-full"
            style={{ left: `${lo}%` }}
          />
        </div>
        <div className="text-muted mt-[7px] flex items-center justify-between text-[11.5px] font-semibold tabular-nums">
          <span>0</span>
          <span>
            {lo.toFixed(0)}–{hi.toFixed(0)} on {measure.sampleSize.toLocaleString()} checks
          </span>
          <span>100</span>
        </div>
      </div>

      <p className="text-muted mt-[14px] mb-0 text-[12.5px] leading-[1.55] text-pretty">{note}</p>
    </div>
  )
}
