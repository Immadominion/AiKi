'use client'

/**
 * Route-level failure.
 *
 * Says what broke and whether trying again is likely to help, rather than
 * apologising and offering a button that does the same thing that just failed.
 * The digest is shown because a user reporting a problem with an id is worth
 * more to us than a tidier screen.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]">
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-10">
        <div className="max-w-[520px]">
          <div className="flex items-center gap-[10px]">
            <span className="bg-warn flex size-[24px] flex-none items-center justify-center rounded-[8px] text-[13px] font-extrabold text-white">
              !
            </span>
            <span className="text-[17px] font-extrabold tracking-[-0.02em]">
              This page could not load.
            </span>
          </div>

          <p className="text-muted mt-[10px] mb-0 text-[13.5px] leading-[1.55] text-pretty">
            Nothing was changed and nothing was spent — this is a read that failed, not an action.
            Your agents keep running to the limits you already set, whether or not this screen
            works.
          </p>

          {error.digest ? (
            <p className="text-faint mt-[10px] mb-0 font-mono text-[11.5px]">
              reference {error.digest}
            </p>
          ) : null}

          <div className="mt-[18px] flex flex-wrap gap-[8px]">
            <button
              type="button"
              onClick={reset}
              className="bg-ink-app hover:bg-orange-app h-[42px] rounded-xl border-0 px-[18px] text-[13.5px] font-bold text-white transition-colors"
            >
              Try again
            </button>
            <a
              href="/activity"
              className="text-ink-app flex h-[42px] items-center rounded-xl bg-[rgb(26_26_25_/_0.055)] px-[18px] text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
            >
              See what agents did
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
