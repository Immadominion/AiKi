'use client'

import Image from 'next/image'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { identitySeed, safeAvatarUrl } from '@/lib/identity'
import { userAvatarTraits } from '@/lib/user-avatar'

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

/** A wallet always receives the same illustrated character, including after reconnecting. */
export function UserAvatar({
  address,
  size = 36,
  className,
}: {
  address: string
  size?: number
  className?: string | undefined
}) {
  const traits = userAvatarTraits(address)
  const face =
    traits.faceShape === 0
      ? 'M21 18c2-6 20-6 22 0v12c0 9-5 14-11 14S21 39 21 30Z'
      : traits.faceShape === 1
        ? 'M20 19c1-7 23-7 24 0l-1 13c-1 8-5 12-11 12S21 40 20 32Z'
        : 'M21 18c3-6 19-6 22 0l1 11c0 10-5 15-12 15S20 39 20 29Z'
  const leftEye = traits.eyes === 1 ? 'M25 29h3' : 'M25.5 28.5v2'
  const rightEye = traits.eyes === 1 ? 'M36 29h3' : 'M37.5 28.5v2'
  const flipped = traits.flip ? 'translate(64 0) scale(-1 1)' : undefined

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Illustrated wallet avatar"
      className={cn('shrink-0 overflow-hidden rounded-xl', className)}
      style={{ width: size, height: size }}
    >
      <rect width="64" height="64" rx="17" fill={traits.background} />
      <circle cx="53" cy="11" r="13" fill={traits.accent} opacity=".14" />
      <path d="M-4 54 19 31 33 54Z" fill="#fff" opacity=".3" />
      <g transform={flipped}>
        <path
          d="M9 65c1-13 9-20 23-20s22 7 23 20Z"
          fill={traits.shirt}
          stroke="#1A1A19"
          strokeWidth="1.7"
        />
        <path d="M27 40h10v10H27Z" fill={traits.skinShade} />
        <circle cx="20.5" cy="29" r="4" fill={traits.skinShade} />
        <circle cx="43.5" cy="29" r="4" fill={traits.skinShade} />
        <path d={face} fill={traits.skin} stroke="#1A1A19" strokeWidth="1.7" />

        {traits.hairStyle === 0 ? (
          <path
            d="M20 25c0-12 6-17 13-17 8 0 13 6 12 17-4-1-7-4-9-8-3 5-8 8-16 8Z"
            fill={traits.hair}
            stroke="#1A1A19"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        ) : null}
        {traits.hairStyle === 1 ? (
          <path
            d="M19 28C17 14 23 8 33 8c9 0 14 7 12 22l-4-1V18c-5 4-11 5-18 3v8Z"
            fill={traits.hair}
            stroke="#1A1A19"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        ) : null}
        {traits.hairStyle === 2 ? (
          <>
            <circle cx="32" cy="8" r="7" fill={traits.hair} stroke="#1A1A19" strokeWidth="1.7" />
            <path
              d="M19 26c0-11 5-16 14-16 8 0 13 6 12 16-7-2-12-6-15-11-1 5-5 9-11 11Z"
              fill={traits.hair}
              stroke="#1A1A19"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </>
        ) : null}
        {traits.hairStyle === 3 ? (
          <path
            d="M19 24c1-11 6-16 14-16 9 0 13 7 12 18l-4-5-4 2-4-6-4 5-5-2Z"
            fill={traits.hair}
            stroke="#1A1A19"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        ) : null}
        {traits.hairStyle === 4 ? (
          <>
            <path
              d="M18 23c1-10 6-15 15-15 8 0 13 5 13 15-8-2-18-2-28 0Z"
              fill={traits.hair}
              stroke="#1A1A19"
              strokeWidth="1.7"
            />
            <path d="M17 22c8-5 20-5 30 0" fill="none" stroke={traits.accent} strokeWidth="4" />
          </>
        ) : null}
        {traits.hairStyle === 5
          ? [21, 27, 33, 39, 44].map((cx, index) => (
              <circle
                key={cx}
                cx={cx}
                cy={index % 2 ? 13 : 16}
                r="6"
                fill={traits.hair}
                stroke="#1A1A19"
                strokeWidth="1.5"
              />
            ))
          : null}

        <path d={leftEye} stroke="#1A1A19" strokeWidth="2.2" strokeLinecap="round" />
        <path d={rightEye} stroke="#1A1A19" strokeWidth="2.2" strokeLinecap="round" />
        {traits.eyes === 2 ? (
          <path
            d="M24 27.5q2-2 4 0M36 27.5q2-2 4 0"
            fill="none"
            stroke="#1A1A19"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        ) : null}
        <path
          d="M31 30.5 30 34h3"
          fill="none"
          stroke={traits.skinShade}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={traits.detail % 2 ? 'M28 37q4 3 8 0' : 'M29 37.5h6'}
          fill="none"
          stroke="#1A1A19"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {traits.glasses === 1 ? (
          <g fill="none" stroke="#1A1A19" strokeWidth="1.5">
            <circle cx="26.5" cy="29.5" r="5" />
            <circle cx="37.5" cy="29.5" r="5" />
            <path d="M31.5 29.5h1" />
          </g>
        ) : null}
        {traits.glasses === 2 ? (
          <g fill="none" stroke="#1A1A19" strokeWidth="1.5">
            <rect x="21.5" y="25" width="10" height="8" rx="2.5" />
            <rect x="32.5" y="25" width="10" height="8" rx="2.5" />
            <path d="M31.5 28.5h1" />
          </g>
        ) : null}
        {traits.glasses === 3 ? (
          <path
            d="M21 27h10l-2 6h-5Zm12 0h10l-3 6h-5Z"
            fill="#1A1A19"
            stroke="#1A1A19"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        ) : null}
        {traits.detail === 3 ? <circle cx="43.5" cy="33" r="1.4" fill={traits.accent} /> : null}
        <path d="M25 49q7 5 14 0" fill="none" stroke="#fff" strokeWidth="2" opacity=".45" />
      </g>
      <rect
        x=".85"
        y=".85"
        width="62.3"
        height="62.3"
        rx="16.15"
        fill="none"
        stroke="#1A1A19"
        strokeOpacity=".12"
        strokeWidth="1.7"
      />
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
