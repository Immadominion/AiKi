import type { LivenessState } from '@aiki/contracts'
import { LIVENESS_DETAIL } from '@/components/ui/LivenessBadge'
import type { Coverage } from '@/lib/search'

const WHY: Partial<Record<LivenessState, string>> = {
  DECLARED_ONLY: 'registered a name and published nothing to call',
  IMPOSTOR_STATIC: 'return the same answer whatever you ask them',
  PLACEHOLDER_URL: 'point at an address that is not real',
  NOT_REMOTE: 'cannot be reached over the network',
  UNREACHABLE: 'did not answer',
}

/**
 * What we searched, and what we left out.
 *
 * Rendered on the page rather than hidden behind a tooltip, because the excluded
 * count is usually larger than the shown count and quietly dropping it is the
 * lie every other explorer tells. A results page that says "6 agents" when it
 * means "6 of 52, and the other 46 are not real" is not a shorter answer, it is
 * a different one.
 */
export function CoverageBlock({ coverage }: { coverage: Coverage }) {
  const { matchedBeforeFilters, excludedUnverified, reasons, indexed } = coverage
  if (!matchedBeforeFilters) return null

  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
      <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-1">
        <span className="text-[14px] font-bold">
          {matchedBeforeFilters - excludedUnverified} shown of {matchedBeforeFilters} that matched
        </span>
        <span className="text-muted text-[12.5px] font-semibold">
          out of {indexed.toLocaleString()} agents we index on BNB Chain
        </span>
      </div>

      {excludedUnverified > 0 ? (
        <>
          <p className="text-muted mt-[7px] mb-0 text-[12.5px] leading-[1.55] text-pretty">
            <b className="text-ink-app font-bold">{excludedUnverified} were left out</b> because we
            could not verify them ourselves. They are counted here rather than deleted. An agent we
            cannot test is a fact about the registry, not an absence.
          </p>

          <div className="mt-[11px] flex flex-col gap-[6px]">
            {reasons.map((r) => (
              <div key={r.state} className="flex items-start gap-[9px]">
                <span className="mt-[6px] size-[5px] flex-none rounded-full bg-[rgb(26_26_25_/_0.18)]" />
                <span className="text-[12.5px] leading-[1.45] text-pretty">
                  <b className="font-bold tabular-nums">{r.count}</b>{' '}
                  <span className="text-muted">
                    {WHY[r.state] ?? LIVENESS_DETAIL[r.state].toLowerCase()}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
