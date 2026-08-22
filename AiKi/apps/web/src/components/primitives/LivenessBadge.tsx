import type { LivenessState } from '@aiki/contracts'
import { cn } from '@/lib/cn'

/**
 * Liveness, in plain language.
 *
 * Seven states, not a green dot. No enum reaches the user — Amina should never read
 * "IMPOSTOR_STATIC". The copy carries the finding; the colour only reinforces it.
 *
 * IMPOSTOR_STATIC is a DISCOVERY, not an error. A third of the BSC registry is this,
 * and no competitor detects it. It should read like the product caught something.
 */
const STATES: Record<
  LivenessState,
  { label: string; blurb: string; dot: string; fg: string; bg: string }
> = {
  LIVE: {
    label: 'Working',
    blurb: 'Answered, and answered specifically for this agent',
    dot: 'var(--color-gain)',
    fg: 'var(--color-gain-deep)',
    bg: 'rgba(0,160,146,.09)',
  },
  DEGRADED: {
    label: 'Unproven',
    blurb: 'Responded, but we could not prove it answers as this agent',
    dot: 'var(--color-warn)',
    fg: 'var(--color-warn-deep)',
    bg: 'var(--color-warn-bg)',
  },
  IMPOSTOR_STATIC: {
    label: 'Not a real agent',
    blurb: 'Returns the same thing whatever you ask — a page wearing an agent’s name',
    dot: 'var(--color-danger)',
    fg: 'var(--color-danger)',
    bg: 'rgba(179,38,30,.07)',
  },
  PLACEHOLDER_URL: {
    label: 'Broken address',
    blurb: 'Published an unfilled template as its endpoint',
    dot: 'var(--color-danger)',
    fg: 'var(--color-danger)',
    bg: 'rgba(179,38,30,.07)',
  },
  NOT_REMOTE: {
    label: 'Local only',
    blurb: 'Declared, but cannot be reached over the network',
    dot: 'var(--color-warn)',
    fg: 'var(--color-warn-deep)',
    bg: 'var(--color-warn-bg)',
  },
  UNREACHABLE: {
    label: 'No answer',
    blurb: 'Declared an endpoint that never responded',
    dot: 'var(--color-grey-400)',
    fg: 'var(--color-grey-500)',
    bg: 'var(--color-muted-bg)',
  },
  DECLARED_ONLY: {
    label: 'No endpoint',
    blurb: 'Registered on-chain, but offers no service at all',
    dot: 'var(--color-grey-400)',
    fg: 'var(--color-grey-500)',
    bg: 'var(--color-muted-bg)',
  },
  UNPROBED: {
    label: 'Not yet checked',
    blurb: 'In the queue to be tested',
    dot: 'var(--color-grey-300)',
    fg: 'var(--color-grey-500)',
    bg: 'var(--color-muted-bg)',
  },
}

export const livenessCopy = (s: LivenessState) => STATES[s]

export function LivenessBadge({
  state,
  size = 'md',
  withBlurb = false,
  className,
}: {
  state: LivenessState
  size?: 'sm' | 'md'
  withBlurb?: boolean
  className?: string
}) {
  const s = STATES[state]
  const sm = size === 'sm'

  return (
    <span className={cn('inline-flex items-start gap-1.5', className)}>
      <span
        className={cn('flex-none rounded-full', state === 'LIVE' && 'animate-breathe')}
        style={{
          width: sm ? 5 : 6,
          height: sm ? 5 : 6,
          marginTop: sm ? 5 : 6,
          background: s.dot,
        }}
      />
      <span className="min-w-0">
        <span
          className="block font-semibold leading-tight"
          style={{ fontSize: sm ? 11 : 12.5, color: s.fg, textWrap: 'pretty' }}
        >
          {s.label}
        </span>
        {withBlurb && (
          <span
            className="mt-0.5 block leading-snug text-grey-400"
            style={{ fontSize: sm ? 10.5 : 11.5, textWrap: 'pretty' }}
          >
            {s.blurb}
          </span>
        )}
      </span>
    </span>
  )
}
