import type { Measure } from '@aiki/contracts'
import { formatScore } from '@/lib/format'

/**
 * The five things the score is made of.
 *
 * Each row shows its own band, so a strong overall score built on one thin
 * component cannot hide inside the average — which is exactly the failure mode
 * a single headline number has.
 */
export function ComponentRows({ rows }: { rows: { label: string; measure: Measure }[] }) {
  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
      {rows.map((r, i) => {
        const { text, withheld } = formatScore(r.measure)
        const [lo, hi] = r.measure.interval ?? [r.measure.value, r.measure.value]
        const none = r.measure.sampleSize === 0

        return (
          <div
            key={r.label}
            className={`flex items-center gap-[10px] px-[14px] py-[13px] sm:gap-[14px] sm:px-[16px] ${i > 0 ? 'border-t border-[rgb(26_26_25_/_0.06)]' : ''}`}
          >
            <span className="w-[118px] flex-none text-[13px] font-semibold sm:w-[152px] sm:text-[13.5px]">
              {r.label}
            </span>

            <span className="relative h-[8px] min-w-0 flex-1 overflow-hidden rounded-full bg-[rgb(26_26_25_/_0.06)]">
              {!none && (
                <>
                  <span
                    className="absolute inset-y-0 rounded-full bg-[rgb(255_90_0_/_0.22)]"
                    style={{ left: `${lo}%`, width: `${Math.max(hi - lo, 0.6)}%` }}
                  />
                  <span
                    className="bg-orange-app absolute inset-y-0 w-[2px] rounded-full"
                    style={{ left: `${lo}%` }}
                  />
                </>
              )}
            </span>

            <span
              className="w-[42px] flex-none text-right text-[14px] font-bold tabular-nums"
              style={{ color: withheld || none ? 'var(--color-faint)' : 'var(--color-ink-app)' }}
            >
              {none ? 'n/a' : text}
            </span>
            <span className="text-muted hidden w-[104px] flex-none text-right text-[12px] font-medium tabular-nums sm:block">
              {none ? 'never observed' : `${r.measure.sampleSize.toLocaleString()} checks`}
            </span>
          </div>
        )
      })}
    </div>
  )
}
