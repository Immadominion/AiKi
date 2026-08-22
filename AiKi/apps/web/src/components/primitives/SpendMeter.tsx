import type { CapPeriod, Money } from '@aiki/contracts'
import { cn } from '@/lib/cn'
import { formatMoney, MoneyValue } from './MoneyValue'

/**
 * Spend against a cap.
 *
 * Renewing and lifetime caps are STRUCTURALLY different components, not one with a
 * label — Privacy.com has shipped that distinction to consumers since 2016 and it is
 * the difference between "this refills" and "this is all you will ever get".
 *
 *   renewing  → a bar with a reset tick and when it resets
 *   lifetime  → a depleting meter that never refills, and says so
 *
 * The shipping SmartSession policy is lifetime-only, so `total` is the honest default.
 * Do not render "per month" until a rolling-window policy is actually deployed.
 */
const PERIOD_COPY: Record<CapPeriod, string> = {
  per_transaction: 'each action',
  per_month: 'this month',
  per_year: 'this year',
  total: 'in total, ever',
}

export function SpendMeter({
  spent,
  cap,
  period,
  resetsAt,
  className,
}: {
  spent: Money
  cap: Money
  period: CapPeriod
  resetsAt?: string
  className?: string
}) {
  const s = Number(spent.amount)
  const c = Number(cap.amount)
  const ratio = c > 0 ? Math.min(1, s / c) : 0
  const renewing = period !== 'total'
  const hot = ratio > 0.85

  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-[13px] font-semibold">
          <MoneyValue value={spent} showAsset={false} />
          <span className="font-normal text-grey-500">
            {' '}
            of {formatMoney(cap)} {cap.asset}
          </span>
        </span>
        <span className="text-[11px] font-medium text-grey-500">{PERIOD_COPY[period]}</span>
      </div>

      {/* Visually a bar; semantically a meter, so assistive tech gets the value.
          The native <meter> is visually hidden and the styled track mirrors it. */}
      <meter
        className="sr-only"
        min={0}
        max={100}
        value={Math.round(ratio * 100)}
        aria-label={`${formatMoney(spent)} of ${formatMoney(cap)} ${cap.asset} used`}
      />
      <div
        aria-hidden
        className="relative mt-2 overflow-hidden rounded-full"
        style={{ height: 6, background: 'var(--color-muted-bg)' }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
          style={{
            width: `${ratio * 100}%`,
            background: hot ? 'var(--color-orange)' : 'var(--color-ink)',
          }}
        />
      </div>

      <div className="mt-1.5 text-[11px] text-grey-500">
        {renewing ? (
          resetsAt ? (
            <>Resets {resetsAt}</>
          ) : (
            <>Refills each period</>
          )
        ) : (
          <>Does not refill — a new approval is needed after this</>
        )}
      </div>
    </div>
  )
}
