import { cn } from '@/lib/cn'

/**
 * Evidence as a countable strip.
 *
 * Non-experts reason about counts, not probabilities — "0.22 confidence" is noise,
 * "3 of 20" is not. Fixed length is the whole point: the EMPTY cells do the work,
 * because the reader sees what is missing rather than what is present.
 *
 * Chunky outlined squares, so it reads as brand rather than as a progress bar — and
 * so it is never mistaken for "setup incomplete".
 */
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
  const filled = Math.min(observed, target)
  const complete = observed >= target

  return (
    <div className={cn('min-w-0', className)}>
      <div
        className="flex flex-wrap gap-[3px]"
        role="img"
        aria-label={`${observed} of ${target} observations`}
      >
        {Array.from({ length: target }, (_, i) => (
          <span
            key={i}
            className="rounded-[3px]"
            style={{
              width: 9,
              height: 12,
              background: i < filled ? 'var(--color-ink)' : 'transparent',
              border: i < filled ? 'none' : '1px solid rgba(20,20,20,.14)',
            }}
          />
        ))}
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
