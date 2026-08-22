import type { EnforcementInfo } from '@aiki/contracts'
import { cn } from '@/lib/cn'

/**
 * Where a promise is actually held.
 *
 * The research lesson that shaped this: Chrome removed the padlock in v117 after
 * finding only ~11% of users understood it, and most read it as "this site is safe."
 * Positive trust badges get ignored or over-read; NEGATIVE indicators change behaviour.
 *
 * So the strong tier is QUIET and the weak tier is LOUD — the inverse of the obvious
 * design. A contract-enforced cap gets a small dark chip; a backend-enforced one gets
 * the yellow treatment and says out loud what it depends on.
 */
const TIERS = {
  T0: {
    label: 'Enforced by contract',
    plain: 'The chain refuses to let this be exceeded — even if AiKi is compromised.',
    quiet: true,
  },
  T1: {
    label: 'Enforced by our signer',
    plain: 'A key we hold refuses to sign past this. Survives a rogue agent, not a rogue AiKi.',
    quiet: false,
  },
  T2: {
    label: 'Checked by AiKi',
    plain: 'Our server checks before relaying. If our server is wrong, this does not hold.',
    quiet: false,
  },
  T3: {
    label: 'Watched, not enforced',
    plain: 'We detect this afterwards and alert you. Nothing prevents it.',
    quiet: false,
  },
} as const

export function EnforcementCell({
  info,
  showPlain = false,
  className,
}: {
  info: EnforcementInfo
  showPlain?: boolean
  className?: string
}) {
  const t = TIERS[info.tier]

  return (
    <span className={cn('inline-flex flex-col gap-1', className)}>
      <span
        className={cn(
          'inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-semibold',
          t.quiet ? 'bg-muted-bg text-grey-700' : 'text-warn-ink',
        )}
        style={t.quiet ? undefined : { background: 'var(--color-warn-bg)' }}
      >
        {!t.quiet && (
          <span
            className="flex h-3.5 w-3.5 flex-none items-center justify-center rounded text-[9px] font-extrabold text-ink"
            style={{ background: 'var(--color-warn)' }}
            aria-hidden
          >
            !
          </span>
        )}
        {t.label}
      </span>

      {showPlain && (
        <span className="text-[11.5px] leading-snug text-grey-500" style={{ textWrap: 'pretty' }}>
          {t.plain}
        </span>
      )}

      {/* An unverified vendor claim is itself a finding, and must be said. */}
      {!info.verified && (
        <span className="text-[11px] font-medium text-warn-deep">
          We have not independently verified this claim.
        </span>
      )}
      {info.caveat && <span className="text-[11px] leading-snug text-grey-500">{info.caveat}</span>}
    </span>
  )
}
