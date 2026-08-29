import type { LivenessState } from '@aiki/contracts'
import Link from 'next/link'
import { LIVENESS_DETAIL } from '@/components/ui/LivenessBadge'
import type { RegistryCoverage } from '@/lib/live'
import { route } from '@/lib/routes'

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
 * How old the newest measurement is, when that is old enough to matter.
 *
 * The evidence engine ran itself into a rate limit and stopped for a day, and
 * every page went on saying "Live from AiKi's evidence API" over numbers that
 * had stopped moving. Reaching the API is not the same as the API knowing
 * anything recent, and only one of those was being reported.
 */
const STALE_AFTER_HOURS = 36
const stalenessOf = (iso: string | null): string | null => {
  if (!iso) return null
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000
  if (!Number.isFinite(hours) || hours < STALE_AFTER_HOURS) return null
  const days = Math.floor(hours / 24)
  return days >= 1
    ? `nothing new in ${days} day${days === 1 ? '' : 's'}`
    : `nothing new in ${Math.floor(hours)} hours`
}

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
  // Staleness is an alarm about the evidence having stopped moving. While the
  // API has not answered yet, the only thing that is old is the fallback we are
  // holding up in the meantime, so raising it here would warn about the wrong
  // thing on every cold load.
  const stale = coverage.freshness === 'asking' ? null : stalenessOf(coverage.sweptAt)

  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
      <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-1">
        <span className="text-[14px] font-bold">{shown} shown for this ask</span>
        <span className="text-muted text-[12.5px] font-semibold">
          {coverage.indexed === null
            ? `behind them, the ${coverage.probed.toLocaleString()} agents AiKi probed on BNB Chain`
            : coverage.indexComplete
              ? `behind them, a registry of ${coverage.indexed.toLocaleString()} agents on BNB Chain`
              : `behind them, ${coverage.indexed.toLocaleString()} agents indexed so far on BNB Chain, which is part of the registry and not all of it`}
        </span>
      </div>

      <p className="text-muted mt-[7px] mb-0 text-[12.5px] leading-[1.55] text-pretty">
        {coverage.indexed === null ? (
          <>Probed by AiKi itself, with our own checks. </>
        ) : (
          <>
            AiKi probed <b className="text-ink-app font-bold">{coverage.probed.toLocaleString()}</b>{' '}
            of them itself.{' '}
          </>
        )}
        <Link
          href={route('/registry')}
          className="text-ink-app font-bold underline decoration-[rgb(26_26_25_/_0.25)] underline-offset-2 hover:decoration-current"
        >
          {coverage.answering} answered like an agent at all
        </Link>
        . The rest are counted here rather than deleted, because an agent we cannot test is a fact
        about the registry, not an absence.
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
          ? `From AiKi's evidence API${coverage.sweptAt ? ` · last sweep ${sweepDay(coverage.sweptAt)}` : ''}`
          : `From AiKi's probe sweep${coverage.sweptAt ? ` of ${sweepDay(coverage.sweptAt)}` : ''} · ${
              coverage.freshness === 'asking'
                ? 'checking for newer numbers'
                : 'live numbers unreachable right now'
            }`}
        {stale ? (
          <>
            {' · '}
            <b className="font-bold text-[#B45309]">{stale}</b>
          </>
        ) : null}
      </p>
    </div>
  )
}
