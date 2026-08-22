/**
 * Shard placement maths, ported from the design reference.
 *
 * Each card is a real trapezoid: a strong rotateY warps it in perspective, rotateZ
 * aims it at the centre, a mask fades its outer edge, and a blurred echo trails
 * further outward so the warp reads as motion rather than as a tilted rectangle.
 *
 * The inner edge is pinned a fixed gap from the centre line rather than positioned
 * absolutely, so the cluster hugs the hero and tucks under it at any width.
 */

export const HERO_W = 'clamp(420px, 100vw - 700px, 660px)'

export type Side = 'l' | 'r'

export interface ShardSpec {
  side: Side
  /** Distance from the centre line to the card's inner edge. */
  gap: number | string
  /** Vertical centre, as a percentage of the stage. */
  top: number
  /** Aim angle. Tier 1 sits flat; tiers 2 and 3 rake toward the middle. */
  rotZ: number
  w: number
  initial: string
  name: string
  capability: string
  state: string
  stateDot: string
  stateColor: string
  bg: string
  glow: string
  dur: string
  delay: string
}

export interface ShardStyle {
  wrap: React.CSSProperties
  smear: React.CSSProperties
  card: React.CSSProperties
  button: React.CSSProperties
}

const px = (g: number | string) => (typeof g === 'number' ? `${g}px` : g)

export function shardStyles(s: ShardSpec, warp = 1, motion = true): ShardStyle {
  const l = s.side === 'l'
  const ry = (l ? 1 : -1) * 26 * warp
  const rz = (l ? -1 : 1) * s.rotZ * warp
  const gap = px(s.gap)

  return {
    wrap: {
      position: 'absolute',
      ...(l
        ? { left: 'auto', right: `calc(50% + ${gap})` }
        : { left: `calc(50% + ${gap})`, right: 'auto' }),
      top: `${s.top}%`,
      width: `min(${s.w}px, calc(50vw - ${gap} - 14px))`,
      transform: `translateY(-50%) perspective(520px) rotateY(${ry}deg) rotateZ(${rz}deg)`,
      transformStyle: 'preserve-3d',
    },
    smear: {
      position: 'absolute',
      ...(l
        ? { left: 'auto', right: `${Math.round(s.w * 0.34)}px` }
        : { left: `${Math.round(s.w * 0.34)}px`, right: 'auto' }),
      top: 8,
      bottom: 8,
      width: `min(${Math.round(s.w * 0.5)}px, calc(25vw - 134px))`,
      background: `linear-gradient(${l ? 'to left' : 'to right'},rgb(20 20 20 / 0),rgb(20 20 20 / 0.1))`,
      filter: 'blur(13px)',
      opacity: 0.38,
      borderRadius: 26,
      pointerEvents: 'none',
    },
    button: {
      pointerEvents: 'auto',
      animationName: motion ? 'aikiDrift' : 'none',
      animationDuration: s.dur,
      animationDelay: s.delay,
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
    },
    card: {
      WebkitMaskImage: `linear-gradient(${l ? '270deg' : '90deg'},rgb(0 0 0 / 0.22) 0%,rgb(0 0 0 / 0.8) 30%,#000 60%)`,
      maskImage: `linear-gradient(${l ? '270deg' : '90deg'},rgb(0 0 0 / 0.22) 0%,rgb(0 0 0 / 0.8) 30%,#000 60%)`,
    },
  }
}

const inner = `calc(${HERO_W} / 2 + 26px)`

/**
 * Six fixed slots. Position, warp and drift belong to the slot; who occupies it
 * and what they are doing belongs to the view, so the composition holds still
 * while the content underneath it changes.
 */
const SLOTS = [
  { side: 'l', gap: inner, top: 50, rotZ: 0, w: 246, dur: '6.6s', delay: '0s' },
  { side: 'r', gap: inner, top: 50, rotZ: 0, w: 246, dur: '7.2s', delay: '.5s' },
  { side: 'l', gap: 268, top: 27, rotZ: -9, w: 246, dur: '7.6s', delay: '.9s' },
  { side: 'r', gap: 268, top: 27, rotZ: -9, w: 246, dur: '6.9s', delay: '1.3s' },
  { side: 'l', gap: 268, top: 73, rotZ: 9, w: 246, dur: '8.2s', delay: '.3s' },
  { side: 'r', gap: 268, top: 73, rotZ: 9, w: 246, dur: '7.9s', delay: '1.6s' },
] as const satisfies readonly Omit<
  ShardSpec,
  'initial' | 'name' | 'capability' | 'state' | 'stateDot' | 'stateColor' | 'bg' | 'glow'
>[]

type Occupant = Pick<
  ShardSpec,
  'initial' | 'name' | 'capability' | 'state' | 'stateDot' | 'stateColor' | 'bg' | 'glow'
>

const GUARDIAN = {
  initial: 'G',
  name: 'Guardian',
  capability: 'Protects lending positions',
  bg: 'linear-gradient(135deg,#FF4D00,#FF8A3D)',
  glow: 'rgb(255 77 0 / 0.5)',
}
const GRIDLY = {
  initial: 'G',
  name: 'Gridly',
  capability: 'Automated grid trading',
  bg: 'linear-gradient(135deg,#7C5CFF,#C05CFF)',
  glow: 'rgb(160 92 255 / 0.45)',
}
const YIELDMAX = {
  initial: 'Y',
  name: 'YieldMax',
  capability: 'Finds better yield',
  bg: 'linear-gradient(135deg,#3B82F6,#8B5CF6)',
  glow: 'rgb(99 102 241 / 0.45)',
}
const LPILOT = {
  initial: 'L',
  name: 'LPilot',
  capability: 'Keeps liquidity in range',
  bg: 'linear-gradient(135deg,#00B3A4,#4ADE80)',
  glow: 'rgb(0 179 164 / 0.4)',
}
const SENTINEL = {
  initial: 'S',
  name: 'Sentinel',
  capability: 'Monitors risk',
  bg: 'linear-gradient(135deg,#F59E0B,#FFD400)',
  glow: 'rgb(245 158 11 / 0.4)',
}
const HARBOR = {
  initial: 'H',
  name: 'Harbor',
  capability: 'Moves idle stables',
  bg: 'linear-gradient(135deg,#0EA5E9,#3B82F6)',
  glow: 'rgb(14 165 233 / 0.4)',
}

const seat = (occupants: Occupant[]): ShardSpec[] =>
  occupants.map((o, i) => ({ ...SLOTS[i % SLOTS.length], ...o }) as ShardSpec)

/** Returning: every shard says what that agent last did for you. */
export const SHARDS_RETURNING: ShardSpec[] = seat([
  {
    ...GUARDIAN,
    state: 'Protected your position · 2m ago',
    stateDot: '#00A092',
    stateColor: '#00857A',
  },
  { ...GRIDLY, state: 'Rebalancing now', stateDot: '#FF4D00', stateColor: '#C93E00' },
  { ...YIELDMAX, state: 'Found 11.8% APY · just now', stateDot: '#3B82F6', stateColor: '#2563EB' },
  { ...LPILOT, state: 'Ready to work · $0.12 / run', stateDot: '#00A092', stateColor: '#5C5C5C' },
  { ...SENTINEL, state: 'Not enough history yet', stateDot: '#FFD400', stateColor: '#8A7400' },
  { ...HARBOR, state: 'Worth hiring next', stateDot: '#3B82F6', stateColor: '#5C5C5C' },
])

/** First run: nothing has happened yet, so each shard says what it offers. */
export const SHARDS_FIRST: ShardSpec[] = seat([
  { ...GUARDIAN, state: 'Available', stateDot: '#00A092', stateColor: '#00857A' },
  { ...YIELDMAX, state: '12 opportunities', stateDot: '#3B82F6', stateColor: '#2563EB' },
  { ...LPILOT, state: 'Available', stateDot: '#00A092', stateColor: '#00857A' },
  { ...GRIDLY, state: '$0.12 / run', stateDot: '#7C5CFF', stateColor: '#6D4AE0' },
  { ...SENTINEL, state: 'New, still being tested', stateDot: '#FFD400', stateColor: '#8A7400' },
  { ...HARBOR, state: '96 checks so far', stateDot: '#3B82F6', stateColor: '#2563EB' },
])
