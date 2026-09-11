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
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[22px] bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]">
      <div className="flex min-h-full items-center justify-center px-4 py-10">
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
            The screen failed before it could confirm the latest result. Check Work or Points before
            repeating a payment or signed action. Your existing agents keep running to the limits
            you already set.
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
              href="/work"
              className="text-ink-app flex h-[42px] items-center rounded-xl bg-[rgb(26_26_25_/_0.055)] px-[18px] text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
            >
              Check your work
            </a>
            <a
              href="/credits"
              className="text-muted flex h-[42px] items-center px-2 text-[13px] font-semibold underline underline-offset-4"
            >
              Check points
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
