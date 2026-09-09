'use client'

import Image from 'next/image'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { identitySeed, safeAvatarUrl } from '@/lib/identity'

/** Original, deterministic robot marks for agents without working artwork. */
export function AgentAvatar({
  identity,
  name,
  src,
  size = 40,
  className,
}: {
  identity: string
  name: string
  src?: string | null | undefined
  size?: number
  className?: string | undefined
}) {
  const url = safeAvatarUrl(src)
  const [failed, setFailed] = useState<string | undefined>()
  const seed = identitySeed(identity)
  const dark = seed % 4 === 0
  const round = 9 + (seed % 7)
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 overflow-hidden rounded-xl bg-surface-sunk',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {url && failed !== url ? (
        <Image
          unoptimized
          src={url}
          alt={name}
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(url)}
          className="h-full w-full object-cover"
        />
      ) : (
        <svg viewBox="0 0 64 64" role="img" aria-label={`${name} avatar`} className="h-full w-full">
          <rect
            width="64"
            height="64"
            rx="16"
            fill={dark ? 'var(--color-ink-app)' : 'var(--color-work-bg)'}
          />
          <path
            d={seed % 2 ? 'M32 18V10M28 10h8' : 'M23 18l-4-7M41 18l4-7'}
            fill="none"
            stroke="var(--color-orange-app)"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <rect x="10" y="27" width="8" height="15" rx="4" fill="var(--color-orange-app)" />
          <rect x="46" y="27" width="8" height="15" rx="4" fill="var(--color-orange-app)" />
          <rect
            x="15"
            y="18"
            width="34"
            height="33"
            rx={round}
            fill={dark ? 'var(--color-surface)' : 'var(--color-orange-app)'}
          />
          <rect x="19" y="24" width="26" height="17" rx="7" fill="var(--color-ink-app)" />
          <path
            d={seed % 3 ? 'M25 30v4M39 30v4' : 'M23 33l3-3 3 3M35 33l3-3 3 3'}
            fill="none"
            stroke="var(--color-surface)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={seed % 2 ? 'M28 45h8' : 'M29 44q3 4 6 0'}
            fill="none"
            stroke={dark ? 'var(--color-orange-app)' : 'var(--color-surface)'}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <circle cx="52" cy="11" r={2 + (seed % 3)} fill="var(--color-orange-app)" opacity=".45" />
        </svg>
      )}
    </span>
  )
}

/** A wallet always receives the same mark, including after reconnecting. */
export function UserAvatar({
  address,
  size = 36,
  className,
}: {
  address: string
  size?: number
  className?: string | undefined
}) {
  const seed = identitySeed(address)
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="Wallet avatar"
      className={cn('shrink-0 rounded-xl', className)}
      style={{ width: size, height: size }}
    >
      <rect width="48" height="48" rx="13" fill="var(--color-work-bg)" />
      {Array.from({ length: 9 }, (_, index) => {
        const x = 8 + (index % 3) * 12
        const y = 8 + Math.floor(index / 3) * 12
        const round = (seed >>> (index * 2)) & 1
        return (
          <rect
            key={`${x}:${y}`}
            x={x}
            y={y}
            width="9"
            height="9"
            rx={round ? 4.5 : 2}
            fill={(seed >>> index) & 1 ? 'var(--color-orange-app)' : 'var(--color-ink-app)'}
            transform={`rotate(${((seed >>> (index + 5)) & 1) * 45} ${x + 4.5} ${y + 4.5})`}
          />
        )
      })}
    </svg>
  )
}

/**
 * Agent identity mark. Rounded square in the app, circle on the ask page -
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
