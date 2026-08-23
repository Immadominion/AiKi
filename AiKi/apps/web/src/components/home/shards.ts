import { AGENT_BY_KEY } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'
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

/**
 * The same maths, measured against two different boxes.
 *
 * Full screen the cluster is sized in viewport units. Embedded in a panel it has
 * to be sized against the panel, so the unit swaps to `cqw` and the container
 * declares `container-type: inline-size`. Everything else is identical, which is
 * the point: one composition, two homes.
 */
export interface Frame {
  unit: 'vw' | 'cqw'
  hero: string
  /** Distance from the centre line for the two flat cards. */
  innerGap: string
  /** Distance for the four raked cards. */
  outerGap: number
  cardW: number
  /**
   * Presentation, kept here rather than in the component, because every one of
   * these is the same measurement expressed for a different box. Splitting them
   * across two files is how the two variants drift apart.
   *
   * These are literal class strings so Tailwind's scanner still sees them.
   */
  heroClass: string
  titleClass: string
  greetClass: string
  vignetteInner: string
  vignetteOuter: string
  /** Below this the cluster has no room either side of the hero. */
  hideBelow: 'lg' | 'xl'
}

export const SCREEN: Frame = {
  unit: 'vw',
  hero: 'clamp(420px, 100vw - 700px, 660px)',
  innerGap: 'calc(clamp(420px, 100vw - 700px, 660px) / 2 + 26px)',
  outerGap: 268,
  cardW: 246,
  heroClass: 'w-[calc(100vw-32px)] max-w-[660px] lg:w-[clamp(420px,calc(100vw-700px),660px)]',
  titleClass: 'text-[clamp(30px,7vw,54px)]',
  greetClass: 'text-[14px]',
  vignetteInner: 'h-[min(46%,340px)] w-[min(46%,600px)]',
  vignetteOuter: 'h-[min(52%,400px)] w-[min(52%,700px)]',
  hideBelow: 'lg',
}

export const PANEL: Frame = {
  unit: 'cqw',
  hero: 'clamp(300px, 100cqw - 520px, 540px)',
  innerGap: 'calc(clamp(300px, 100cqw - 520px, 540px) / 2 + 20px)',
  outerGap: 214,
  cardW: 216,
  heroClass: 'w-[calc(100cqw-32px)] max-w-[540px] xl:w-[clamp(300px,calc(100cqw-520px),540px)]',
  titleClass: 'text-[clamp(26px,4.6cqw,40px)]',
  greetClass: 'text-[13px]',
  vignetteInner: 'h-[min(46%,300px)] w-[min(46%,520px)]',
  vignetteOuter: 'h-[min(52%,360px)] w-[min(52%,600px)]',
  hideBelow: 'xl',
}

export const HERO_W = SCREEN.hero

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

export function shardStyles(
  s: ShardSpec,
  frame: Frame = SCREEN,
  warp = 1,
  motion = true,
): ShardStyle {
  const l = s.side === 'l'
  const ry = (l ? 1 : -1) * 26 * warp
  const rz = (l ? -1 : 1) * s.rotZ * warp
  // Slot gaps are authored against the screen frame, so they scale with it.
  const gap =
    s.gap === '@inner'
      ? frame.innerGap
      : typeof s.gap === 'number'
        ? `${Math.round(s.gap * (frame.outerGap / SCREEN.outerGap))}px`
        : px(s.gap)
  const w = Math.round(s.w * (frame.cardW / SCREEN.cardW))
  const u = frame.unit

  return {
    wrap: {
      position: 'absolute',
      ...(l
        ? { left: 'auto', right: `calc(50% + ${gap})` }
        : { left: `calc(50% + ${gap})`, right: 'auto' }),
      top: `${s.top}%`,
      width: `min(${w}px, calc(50${u} - ${gap} - 14px))`,
      transform: `translateY(-50%) perspective(520px) rotateY(${ry}deg) rotateZ(${rz}deg)`,
      transformStyle: 'preserve-3d',
    },
    smear: {
      position: 'absolute',
      ...(l
        ? { left: 'auto', right: `${Math.round(w * 0.34)}px` }
        : { left: `${Math.round(w * 0.34)}px`, right: 'auto' }),
      top: 8,
      bottom: 8,
      width: `min(${Math.round(w * 0.5)}px, calc(25${u} - 134px))`,
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
      // The fade is what makes a shard look warped away from you. It has to
      // lift when you reach for the card, or you are being asked to click
      // something you cannot read.
      ['--shard-dir' as string]: l ? '270deg' : '90deg',
      WebkitMaskImage:
        'linear-gradient(var(--shard-dir),rgb(0 0 0 / var(--shard-near)) 0%,rgb(0 0 0 / var(--shard-mid)) 30%,#000 60%)',
      maskImage:
        'linear-gradient(var(--shard-dir),rgb(0 0 0 / var(--shard-near)) 0%,rgb(0 0 0 / var(--shard-mid)) 30%,#000 60%)',
      transition:
        'transform 420ms cubic-bezier(0.22,1,0.36,1), box-shadow 420ms cubic-bezier(0.22,1,0.36,1), border-color 420ms cubic-bezier(0.22,1,0.36,1), --shard-near 380ms cubic-bezier(0.22,1,0.36,1), --shard-mid 380ms cubic-bezier(0.22,1,0.36,1)',
    },
  }
}

const inner = '@inner'

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
    state: 'Protected your position, 2m ago',
    stateDot: '#00A092',
    stateColor: '#00857A',
  },
  { ...GRIDLY, state: 'Rebalancing now', stateDot: '#FF4D00', stateColor: '#C93E00' },
  { ...YIELDMAX, state: 'Found 11.8% APY, just now', stateDot: '#3B82F6', stateColor: '#2563EB' },
  { ...LPILOT, state: 'Ready to work, $0.12 / run', stateDot: '#00A092', stateColor: '#5C5C5C' },
  { ...SENTINEL, state: 'Not enough history yet', stateDot: '#FFD400', stateColor: '#8A7400' },
  { ...HARBOR, state: 'Worth hiring next', stateDot: '#3B82F6', stateColor: '#5C5C5C' },
])

/**
 * Nothing hired yet, so the cards become discovery.
 *
 * Ranked by how much we have actually tested each one, not by popularity. We
 * have no usage data, and inventing a trending list would be the first lie the
 * product tells. Check counts we do have, so those rank the cluster and each
 * card says its own count out loud.
 */
const BY_EVIDENCE = [
  { agent: GUARDIAN, key: 'guardian' as const },
  { agent: LPILOT, key: 'lpilot' as const },
  { agent: YIELDMAX, key: 'yieldmax' as const },
  { agent: GRIDLY, key: 'gridly' as const },
  { agent: HARBOR, key: 'harbor' as const },
  { agent: SENTINEL, key: 'sentinel' as const },
].sort((a, b) => DETAILS[b.key].checks[1] - DETAILS[a.key].checks[1])

export const SHARDS_DISCOVER: ShardSpec[] = seat(
  BY_EVIDENCE.map(({ agent, key }) => {
    const row = AGENT_BY_KEY[key]
    const tone =
      row.evidenceTone === 'strong'
        ? { stateDot: '#00A092', stateColor: '#00857A' }
        : row.evidenceTone === 'fair'
          ? { stateDot: '#3B82F6', stateColor: '#5C5C5C' }
          : { stateDot: '#FFD400', stateColor: '#8A7400' }
    return { ...agent, state: row.evidence, ...tone }
  }),
)
