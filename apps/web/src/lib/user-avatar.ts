import { identitySeed } from './identity'

/**
 * A wallet gets one illustrated character for this avatar version.
 *
 * Traits are derived instead of stored, so the same address has the same face
 * on every device and no profile image has to leave the browser.
 */
export interface UserAvatarTraits {
  background: string
  accent: string
  skin: string
  skinShade: string
  hair: string
  shirt: string
  hairStyle: number
  faceShape: number
  eyes: number
  glasses: number
  detail: number
  flip: boolean
}

const BACKGROUNDS = ['#FFDCCE', '#DDEAFF', '#E8DEFF', '#D8F4E7', '#FFF0B8', '#FFDCEB'] as const
const ACCENTS = ['#FF5A00', '#3B82F6', '#7C5CFC', '#00A092', '#F2B705', '#E94B8A'] as const
const SKINS = [
  ['#FFDCC5', '#E6A77C'],
  ['#F3C39F', '#D68E61'],
  ['#D99B70', '#B86C46'],
  ['#B96F4B', '#8E4B31'],
  ['#8B5138', '#633321'],
  ['#643B2D', '#45251B'],
] as const
const HAIR = ['#191918', '#4A2C22', '#7A4828', '#D89A38', '#EAE4D7', '#5C3D8A'] as const
const SHIRTS = ['#FF5A00', '#1A1A19', '#3B82F6', '#7C5CFC', '#00A092', '#F2B705'] as const

function mix(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return value >>> 0
}

function pick<T>(values: readonly T[], seed: number, salt: number): T {
  return values[mix(seed, salt) % values.length] as T
}

export function userAvatarTraits(identity: string): UserAvatarTraits {
  const normalized = identity.trim().toLowerCase() || 'guest'
  const seed = identitySeed(`aiki:user-avatar:v1:${normalized}`)
  const [skin, skinShade] = pick(SKINS, seed, 2)
  const background = pick(BACKGROUNDS, seed, 0)
  const accent = pick(ACCENTS, seed, 1)

  return {
    background,
    accent,
    skin,
    skinShade,
    hair: pick(HAIR, seed, 3),
    shirt: pick(SHIRTS, seed, 4),
    hairStyle: mix(seed, 5) % 6,
    faceShape: mix(seed, 6) % 3,
    eyes: mix(seed, 7) % 3,
    glasses: mix(seed, 8) % 4,
    detail: mix(seed, 9) % 4,
    flip: Boolean(mix(seed, 10) & 1),
  }
}
