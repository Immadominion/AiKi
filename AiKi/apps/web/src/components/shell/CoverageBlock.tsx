import type { LivenessState } from '@aiki/contracts'
import { LIVENESS_DETAIL } from '@/components/ui/LivenessBadge'
import type { RegistryCoverage } from '@/lib/live'

const WHY: Partial<Record<LivenessState, string>> = {
  DECLARED_ONLY: 'registered a name and published nothing to call',
  IMPOSTOR_STATIC: 'return the same answer whatever you ask them',
  PLACEHOLDER_URL: 'point at an address that is not real',
  NOT_REMOTE: 'cannot be reached over the network',
  UNREACHABLE: 'did not answer',
}

const sweepDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * What we searched, and what we left out.
 *
 * Rendered on the page rather than hidden behind a tooltip, because the excluded
 * count is usually larger than the shown count and quietly dropping it is the
 * lie every other explorer tells. Every number here is a measurement: live from
 * the evidence API when it answers, otherwise from the committed probe sweep,
 * and the block says which of the two you are reading.
 */
export function CoverageBlock({ shown, coverage }: { shown: number; coverage: RegistryCoverage }) {
  if (!shown) return null
  const excluded = coverage.probed - coverage.answering

  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
      <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-1">
        <span className="text-[14px] font-bold">{shown} shown for this ask</span>
        <span className="text-muted text-[12.5px] font-semibold">
          behind them, a registry of {coverage.indexed.toLocaleString()} agents on BNB Chain
        </span>
      </div>

      <p className="text-muted mt-[7px] mb-0 text-[12.5px] leading-[1.55] text-pretty">
        AiKi probed <b className="text-ink-app font-bold">{coverage.probed.toLocaleString()}</b> of
        them itself. <b className="text-ink-app font-bold">{coverage.answering}</b> answered like an
        agent at all. The rest are counted here rather than deleted, because an agent we cannot test
        is a fact about the registry, not an absence.
      </p>

      {excluded > 0 ? (
        <div className="mt-[11px] flex flex-col gap-[6px]">
          {coverage.reasons.map((r) => (
            <div key={r.state} className="flex items-start gap-[9px]">
              <span className="mt-[6px] size-[5px] flex-none rounded-full bg-[rgb(26_26_25_/_0.18)]" />
              <span className="text-[12.5px] leading-[1.45] text-pretty">
                <b className="font-bold tabular-nums">{r.count.toLocaleString()}</b>{' '}
                <span className="text-muted">
                  {WHY[r.state] ?? LIVENESS_DETAIL[r.state].toLowerCase()}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <p className="text-muted-3 mt-[10px] mb-0 text-[11.5px] leading-[1.45]">
        {coverage.freshness === 'live'
          ? `Live from AiKi's evidence API · last sweep ${sweepDay(coverage.sweptAt)}`
          : `From AiKi's probe sweep of ${sweepDay(coverage.sweptAt)} · live numbers unreachable right now`}
      </p>
    </div>
  )
}
