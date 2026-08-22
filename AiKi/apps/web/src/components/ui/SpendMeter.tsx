/**
 * Spend against the cap the user set.
 *
 * The number leads and the bar follows, because the number is the fact and the
 * bar is only its shape. `hot` turns the fill orange past a quarter of the cap —
 * not a warning, just the point where the shape becomes worth reading.
 */
export function SpendMeter({
  value,
  cap,
  pct,
  hot,
}: {
  value: string
  cap: string
  pct: string
  hot?: boolean | undefined
}) {
  return (
    <span className="w-full min-w-0">
      <span className="block text-[13.5px] font-bold tabular-nums">
        {value} <span className="text-muted text-[12px] font-medium">of {cap}</span>
      </span>
      <span className="mt-[7px] block h-[5px] overflow-hidden rounded-full bg-[rgb(26_26_25_/_0.07)]">
        <span
          className="block h-full rounded-full"
          style={{
            width: pct,
            background: hot ? 'var(--color-orange-app)' : 'var(--color-ink-app)',
          }}
        />
      </span>
      <span className="sr-only">
        {value} spent of a {cap} cap.
      </span>
    </span>
  )
}
