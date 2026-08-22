/**
 * Loading placeholders shaped like the thing that is coming.
 *
 * A spinner tells you to wait; a shape tells you what for, and stops the page
 * jumping when it arrives. The rule this exists to keep: once a number has been
 * rendered it is NEVER replaced by a skeleton. A skeleton is for the first load
 * only — a refresh shows the old number until there is a new one.
 */
export function Bar({ w = '100%', h = 12 }: { w?: string | number; h?: number }) {
  return (
    <span
      aria-hidden
      className="block rounded-full bg-[rgb(26_26_25_/_0.07)]"
      style={{ width: w, height: h }}
    />
  )
}

export function RowSkeleton() {
  return (
    <div className="flex items-center gap-[14px] border-b border-[rgb(26_26_25_/_0.06)] px-[14px] py-[15px] last:border-b-0">
      <span className="size-9 flex-none rounded-xl bg-[rgb(26_26_25_/_0.07)]" />
      <span className="flex min-w-0 flex-1 flex-col gap-[7px]">
        <Bar w="42%" h={11} />
        <Bar w="26%" h={9} />
      </span>
      <span className="hidden w-[160px] flex-none sm:block">
        <Bar w="80%" h={11} />
      </span>
      <span className="hidden w-[90px] flex-none sm:block">
        <Bar w="60%" h={11} />
      </span>
    </div>
  )
}

// Placeholder rows have no identity to key on, so they are given one rather
// than keyed by position.
const ROW_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const

/** The whole card, for a first paint with nothing to show yet. */
export function PageSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]">
      <div className="flex-none px-4 pt-[18px] md:px-[22px]">
        <div className="flex items-center gap-[10px]">
          <Bar w={120} h={16} />
          <Bar w={90} h={11} />
        </div>
        <div className="-mx-4 mt-4 h-px bg-[rgb(26_26_25_/_0.07)] md:-mx-[22px]" />
      </div>
      <div className="flex-none px-4 pt-4 md:px-[22px]">
        <Bar w={220} h={38} />
      </div>
      <div className="min-h-0 flex-1 px-4 pt-4 pb-[22px] md:px-[22px]">
        <div className="rounded-2xl border border-[rgb(26_26_25_/_0.08)]">
          {ROW_IDS.slice(0, rows).map((id) => (
            <RowSkeleton key={id} />
          ))}
        </div>
        <p className="text-faint mt-[14px] mb-0 text-[12.5px]">Reading the chain and our probes…</p>
      </div>
    </div>
  )
}
