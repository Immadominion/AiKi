import { cn } from '@/lib/cn'

/**
 * Agent avatar — gradient disc with the agent's initial.
 *
 * Gradients are assigned deterministically from the agent id so the same agent is
 * always the same colour. Purple lives here and ONLY here: as an avatar fill it is
 * identity, not chrome.
 */
const GRADIENTS = [
  'linear-gradient(135deg,#FF4D00,#FF8A3D)',
  'linear-gradient(135deg,#00B3A4,#4ADE80)',
  'linear-gradient(135deg,#3B82F6,#8B5CF6)',
  'linear-gradient(135deg,#7C5CFF,#C05CFF)',
  'linear-gradient(135deg,#FF4D00,#FFB300)',
] as const

const GLOWS = [
  'rgba(255,77,0,.55)',
  'rgba(0,179,164,.5)',
  'rgba(59,130,246,.5)',
  'rgba(124,92,255,.5)',
  'rgba(255,77,0,.5)',
] as const

const SIZES = {
  sm: { box: 26, font: 11 },
  md: { box: 34, font: 13 },
  lg: { box: 40, font: 15 },
  xl: { box: 48, font: 18 },
} as const

function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function AgentAvatar({
  name,
  id,
  size = 'md',
  glow = false,
  className,
}: {
  name: string
  /** Stable key for colour assignment. Falls back to name. */
  id?: string
  size?: keyof typeof SIZES
  glow?: boolean
  className?: string
}) {
  const i = hash(id ?? name) % GRADIENTS.length
  const { box, font } = SIZES[size]
  const initial = name.trim().charAt(0).toUpperCase() || '?'

  return (
    <span
      aria-hidden
      className={cn(
        'flex flex-none items-center justify-center rounded-full text-white font-extrabold',
        className,
      )}
      style={{
        width: box,
        height: box,
        fontSize: font,
        background: GRADIENTS[i],
        ...(glow ? { boxShadow: `0 8px 18px -8px ${GLOWS[i]}` } : {}),
      }}
    >
      {initial}
    </span>
  )
}
