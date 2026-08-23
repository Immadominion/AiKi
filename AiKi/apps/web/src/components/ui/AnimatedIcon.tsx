'use client'

import { useId, useRef } from 'react'

/**
 * A button whose icon animates while you are on it.
 *
 * The icons from @animateicons/react expose an imperative handle rather than a
 * hover prop, which is the right call: the thing being hovered is usually the
 * button, not the 14px glyph inside it. This wires the two together so the
 * whole target is the trigger.
 */
interface IconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

type IconComponent = React.ForwardRefExoticComponent<
  { size?: number; color?: string; duration?: number } & React.RefAttributes<IconHandle>
>

/**
 * Wire an animated icon to something else's hover.
 *
 * These icons expose an imperative handle rather than a hover prop, which is
 * right: the thing being hovered is a nav row or a chip, not the 18px glyph
 * inside it. Spread `hoverProps` on whatever the real target is and hand `ref`
 * to the icon.
 */
export function useHoverIcon() {
  const ref = useRef<IconHandle>(null)
  return {
    ref,
    hoverProps: {
      onMouseEnter: () => ref.current?.startAnimation(),
      onMouseLeave: () => ref.current?.stopAnimation(),
      onFocus: () => ref.current?.startAnimation(),
      onBlur: () => ref.current?.stopAnimation(),
    },
  }
}

export function IconButton({
  icon: Icon,
  label,
  tooltip = label,
  ariaKeyShortcuts,
  onClick,
  size = 14,
  className = '',
  tone = 'quiet',
}: {
  icon: IconComponent
  label: string
  tooltip?: string
  ariaKeyShortcuts?: string
  onClick: () => void
  size?: number
  className?: string
  /** `quiet` sits in the chrome; `warm` tints toward the brand on hover. */
  tone?: 'quiet' | 'warm'
}) {
  const ref = useRef<IconHandle>(null)
  const tooltipId = useId()

  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={tooltip === label ? undefined : tooltipId}
      aria-keyshortcuts={ariaKeyShortcuts}
      onClick={onClick}
      onMouseEnter={() => ref.current?.startAnimation()}
      onMouseLeave={() => ref.current?.stopAnimation()}
      onFocus={() => ref.current?.startAnimation()}
      onBlur={() => ref.current?.stopAnimation()}
      className={`group relative flex min-h-10 min-w-10 items-center justify-center rounded-full border-0 transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-[var(--color-orange-app)] focus-visible:ring-offset-2 ${
        tone === 'warm'
          ? 'bg-[#F3F3F1] text-[#8A8A8A] hover:bg-[var(--color-orange-wash)] hover:text-[var(--color-orange-lit)]'
          : 'bg-transparent text-[#8A8A8A] hover:text-[var(--color-orange-lit)]'
      } ${className}`}
    >
      <span aria-hidden>
        <Icon ref={ref} size={size} color="currentColor" />
      </span>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none invisible absolute top-[calc(100%+8px)] right-0 z-100 translate-y-[-2px] rounded-[8px] bg-[#1A1A19] px-[9px] py-[6px] text-[11px] leading-none font-semibold whitespace-nowrap text-white opacity-0 shadow-[0_8px_24px_-10px_rgb(20_20_20_/_0.65)] transition-[opacity,transform] duration-150 ease-out group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:visible group-focus-visible:translate-y-0 group-focus-visible:opacity-100"
      >
        {tooltip}
      </span>
    </button>
  )
}

/**
 * The stroke that runs the border of a panel when it opens.
 *
 * Drawn as an SVG overlay rather than with a border, because a border cannot be
 * partially drawn. `pathLength="100"` normalises the perimeter so one set of
 * dash values works at every panel size.
 */
export function TraceBorder({
  radius = 26,
  duration = 1.35,
  className = '',
}: {
  radius?: number
  duration?: number
  className?: string
}) {
  return (
    <svg
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      preserveAspectRatio="none"
    >
      <title>Panel outline</title>
      <defs>
        <linearGradient id="aiki-trace" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-orange)" />
          <stop offset="55%" stopColor="var(--color-orange-lit)" />
          <stop offset="100%" stopColor="var(--color-orange-soft)" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="calc(100% - 2px)"
        height="calc(100% - 2px)"
        rx={radius}
        fill="none"
        stroke="url(#aiki-trace)"
        strokeWidth="2"
        strokeLinecap="round"
        pathLength={100}
        style={{
          // Ease-out, but not so hard that the arc parks for most of the
          // timeline. Quartic gets the fast start without the dead middle.
          animation: `aikiTrace ${duration}s cubic-bezier(0.25, 1, 0.5, 1) both, aikiTraceFade ${duration}s linear both`,
        }}
      />
    </svg>
  )
}
