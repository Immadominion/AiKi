import type { StrategySetupView } from '@aiki/contracts/strategies'
import { FOCUS, PANEL } from './PolicyForm'
import { hash } from './review'

const timestamp = (value: string) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : 'Not available'
}
export function StrategyActivity({ watch }: { watch: StrategySetupView['watch'] }) {
  if (!watch)
    return (
      <section className={PANEL}>
        <h2 className="m-0 text-base font-bold">Strategy activity</h2>
        <p className="text-muted mt-2 mb-0 text-sm leading-relaxed">
          No strategy watch is registered yet. A deployment or funding receipt does not mean
          automation is running.
        </p>
      </section>
    )
  const status = {
    ACTIVE: 'Watching within your limits',
    PAUSED: 'Checks are paused',
    NEEDS_REVIEW: 'Pending execution needs review',
    CLOSED: 'Watch closed',
  }[watch.status]
  return (
    <section className={PANEL} aria-label="Strategy activity">
      <h2 className="m-0 text-base font-bold">Strategy activity</h2>
      <p className="mt-2 mb-0 text-sm font-semibold" role="status">
        {status}
      </p>
      {watch.lastDecision ? (
        <div className="mt-3 rounded-xl bg-surface-sunk p-3">
          <p className="text-body m-0 text-sm leading-relaxed">{watch.lastDecision.reason}</p>
          <p className="text-muted mt-2 mb-0 text-xs">
            Last check: {timestamp(watch.lastDecision.at)}
          </p>
        </div>
      ) : (
        <p className="text-muted text-sm">No completed strategy check yet.</p>
      )}
      {watch.status === 'ACTIVE' ? (
        <p className="text-muted mt-3 mb-0 text-xs leading-relaxed">
          Next check: {timestamp(watch.nextRunAt)}. A scheduled check may wait or refuse; it is not
          a promised trade.
        </p>
      ) : null}
      {watch.status === 'NEEDS_REVIEW' ? (
        <p className="text-work-ink mt-3 mb-0 text-sm leading-relaxed">
          New execution remains blocked until the original attempt is reconciled. Recovery does not
          automatically restart this watch.
        </p>
      ) : null}
      {hash(watch.lastTransactionHash) ? (
        <a
          className={`mt-2 inline-flex min-h-10 items-center text-xs font-semibold underline ${FOCUS}`}
          href={`https://bscscan.com/tx/${watch.lastTransactionHash}`}
          target="_blank"
          rel="noreferrer"
        >
          Latest finalized execution receipt ↗
        </a>
      ) : null}
    </section>
  )
}
