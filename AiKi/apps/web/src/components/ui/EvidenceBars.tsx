import type { EvidenceTone } from '@/lib/agents'

const TONE: Record<EvidenceTone, string> = {
  strong: 'text-good-ink',
  fair: 'text-muted',
  thin: 'text-warn-ink',
}

/**
 * Five bars, one per batch of checks AiKi ran itself.
 *
 * Empty bars mean missing evidence, not bad performance — a distinction the
 * footnote under every table has to keep making, because a five-segment meter
 * reads as a rating unless you say otherwise.
 */
export function EvidenceBars({
  filled,
  label,
  tone,
  height = 17,
}: {
  filled: number
  label: string
  tone: EvidenceTone
  height?: number
}) {
  return (
    <span className="flex min-w-0 items-center gap-[10px]">
      <span className="flex flex-none gap-[2.5px]" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="w-[5px] rounded-[2px]"
            style={{
              height,
              background: i < filled ? 'var(--color-orange-app)' : 'rgb(255 90 0 / 0.18)',
            }}
          />
        ))}
      </span>
      <span className={`min-w-0 text-[12.5px] font-semibold ${TONE[tone]}`}>{label}</span>
    </span>
  )
}
