'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'

const PIXELS = [
  ['pixel-nw', '90ms'],
  ['pixel-n', '180ms'],
  ['pixel-ne', '270ms'],
  ['pixel-w', '0ms'],
  ['pixel-c', '90ms'],
  ['pixel-e', '180ms'],
  ['pixel-sw', '90ms'],
  ['pixel-s', '180ms'],
  ['pixel-se', '270ms'],
] as const

/**
 * Branded progress for work whose shape cannot be known in advance.
 *
 * Data lists still use matching skeletons. This is reserved for agent work,
 * wallet handoffs, and other operations where a named activity is more useful
 * than pretending we know the final layout.
 */
export function AiKiActivity({
  label,
  detail,
  elapsed = true,
  compact = false,
  className,
}: {
  label: string
  detail?: string
  elapsed?: boolean
  compact?: boolean
  className?: string
}) {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (!elapsed) return
    const started = Date.now()
    const update = () => setSeconds(Math.floor((Date.now() - started) / 1000))
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [elapsed])

  return (
    <div
      role="status"
      className={cn(
        'flex min-w-0 items-center gap-3',
        compact ? 'py-1' : 'rounded-[16px] bg-surface-sunk px-4 py-3',
        className,
      )}
    >
      <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[2px]">
        {PIXELS.map(([id, delay]) => (
          <span
            key={id}
            className="aiki-activity-pixel size-1 rounded-[1px]"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="aiki-shimmer-text block w-fit text-[12.5px] font-semibold">{label}</span>
        {detail ? (
          <span className="text-muted mt-0.5 block text-[11.5px] leading-[1.45]">{detail}</span>
        ) : null}
      </span>
      {elapsed && seconds >= 2 ? (
        <span aria-hidden className="text-faint flex-none font-mono text-[10.5px] tabular-nums">
          {seconds}s
        </span>
      ) : null}
    </div>
  )
}
