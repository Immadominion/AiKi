import { cn } from '@/lib/cn'

/**
 * Agent identity mark. Rounded square in the app, circle on the ask page —
 * that difference is in the reference and it is load-bearing: the ask page's
 * shards are soft and floating, the app's rows are dense and gridded.
 */
export function Avatar({
  initial,
  bg,
  size = 36,
  radius = 12,
  className,
  glow,
}: {
  initial: string
  bg: string
  size?: number
  radius?: number | 'full'
  className?: string | undefined
  glow?: string | undefined
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex flex-none items-center justify-center font-extrabold text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: radius === 'full' ? '50%' : radius,
        background: bg,
        fontSize: Math.round(size * 0.39),
        ...(glow ? { boxShadow: `0 8px 18px -8px ${glow}` } : {}),
      }}
    >
      {initial}
    </span>
  )
}
