import { cn } from '@/lib/cn'

/**
 * Evidence as a countable strip.
 *
 * Non-experts reason about counts, not probabilities — "0.22 confidence" is noise,
 * "3 of 20" is not. Fixed length is the whole point: the EMPTY cells do the work,
 * because the reader sees what is missing rather than what is present.
 *
 * Drawn with repeating gradients rather than N elements: one node instead of twenty,
 * scales to any target, and the cells are decorative so they carry no semantics worth
 * putting in the DOM. The accessible value lives on the wrapper's aria-label.
 */

const CELL = 9
const GAP = 3
const PITCH = CELL + GAP

export function EvidenceStrip({
  observed,
  target = 20,
  label,
  className,
}: {
  observed: number
  target?: number
  label?: string
  className?: string
}) {
  const filled = Math.max(0, Math.min(observed, target))
  const complete = observed >= target

  const cells = (color: string) =>
    `repeating-linear-gradient(to right, ${color} 0 ${CELL}px, transparent ${CELL}px ${PITCH}px)`

  return (
    <div className={cn('min-w-0', className)}>
      <div
        role="img"
        aria-label={`${observed} of ${target} observations`}
        className="relative"
        style={{ width: target * PITCH - GAP, height: 12 }}
      >
        {/* empty cells — outlined, so absence is visible */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-[1px]"
          style={{
            background: cells('rgba(20,20,20,.10)'),
            // hollow the cells so they read as outlines rather than blocks
            maskImage: cells('#000'),
            WebkitMaskImage: cells('#000'),
          }}
        />
        {/* filled cells, clipped to the observed count */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 overflow-hidden"
          style={{ width: filled * PITCH - (filled ? GAP : 0) }}
        >
          <span
            className="absolute inset-0"
            style={{ background: cells('var(--color-ink)') }}
          />
        </span>
      </div>

      <div className="mt-1.5 text-[11px] font-medium text-grey-500">
        {label ??
          (complete ? (
            <>{observed.toLocaleString()} observations — enough to judge</>
          ) : (
            <>
              {observed} of {target} observations — still building a picture
            </>
          ))}
      </div>
    </div>
  )
}
