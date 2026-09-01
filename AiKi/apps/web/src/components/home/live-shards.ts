import type { ProjectedPassport } from '@aiki/contracts'
import { type ShardSpec, seatOccupants } from './shards'

/**
 * The cards on the front door, built from agents that exist.
 *
 * They used to be six invented agents with invented evidence: Guardian with
 * "174 checks", YieldMax with "61 checks", names that appear nowhere in the
 * registry, beside a strapline promising that everything here is measured. A
 * visitor could not tell which numbers on that screen were real, which is worse
 * than showing nothing, and worse again on a product whose entire argument is
 * that nobody else checks.
 *
 * So every field below comes from a passport: the name and the capability line
 * are quoted from the agent's own registration, and the state line is the probe
 * count we actually ran. Nothing here is written by us except the phrasing of
 * the state, and the colour, which claims nothing.
 */

/**
 * Deterministic per agent, and deliberately meaningless.
 *
 * An agent's colour must not encode its score: colour is the first thing read
 * and the last thing anyone checks the definition of, so a palette that meant
 * something would be a claim made in a channel with no room for its evidence.
 * Keyed off the id so a given agent looks the same on every visit.
 */
const PALETTE = [
  { bg: 'linear-gradient(135deg,#FF4D00,#FF8A3D)', glow: 'rgb(255 77 0 / 0.5)' },
  { bg: 'linear-gradient(135deg,#3B82F6,#8B5CF6)', glow: 'rgb(99 102 241 / 0.45)' },
  { bg: 'linear-gradient(135deg,#00B3A4,#4ADE80)', glow: 'rgb(0 179 164 / 0.4)' },
  { bg: 'linear-gradient(135deg,#7C5CFF,#C05CFF)', glow: 'rgb(160 92 255 / 0.45)' },
  { bg: 'linear-gradient(135deg,#F59E0B,#FFD400)', glow: 'rgb(245 158 11 / 0.4)' },
  { bg: 'linear-gradient(135deg,#0EA5E9,#3B82F6)', glow: 'rgb(14 165 233 / 0.4)' },
]

const FALLBACK = { bg: 'linear-gradient(135deg,#FF4D00,#FF8A3D)', glow: 'rgb(255 77 0 / 0.5)' }

const paletteFor = (agentId: string): { bg: string; glow: string } => {
  let hash = 0
  for (const ch of agentId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length] ?? FALLBACK
}

/** The first letter an agent actually calls itself by. */
function initialOf(name: string | null, agentId: string): string {
  const letter = (name ?? '')
    .trim()
    .replace(/^AiKi\s+/i, '')
    .charAt(0)
  return (letter || agentId.charAt(0) || '?').toUpperCase()
}

/**
 * A card is one line wide. Registration descriptions are paragraphs, so the
 * first sentence is taken whole rather than cut mid-word, and only truncated if
 * that sentence is itself too long.
 */
function capabilityOf(passport: ProjectedPassport): string {
  const description = (passport.description ?? '').trim()
  if (!description) return 'Declares no description'
  const sentence = description.split(/(?<=\.)\s/)[0] ?? description
  const cleaned = sentence.replace(/^First-party(,| ) ?(read-only )?reference agent that /i, '')
  const text = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return text.length > 64 ? `${text.slice(0, 61).trimEnd()}...` : text.replace(/\.$/, '')
}

/**
 * What we have actually established about it, phrased as a finding.
 *
 * The trial count is the honest denominator and it is said out loud, because
 * "Strong" over three probes and "Strong" over three hundred are different
 * claims and the adjective alone hides which one this is.
 */
function stateOf(passport: ProjectedPassport): {
  state: string
  stateDot: string
  stateColor: string
} {
  const trials = passport.checks?.trials ?? 0
  const probes = trials === 1 ? '1 check' : `${trials} checks`

  if (passport.liveness === 'LIVE')
    return trials >= 20
      ? { state: `Answering · ${probes}`, stateDot: '#00A092', stateColor: '#00857A' }
      : { state: `Answering · only ${probes}`, stateDot: '#3B82F6', stateColor: '#5C5C5C' }

  if (passport.liveness === 'DEGRADED')
    return { state: `Answers unreliably · ${probes}`, stateDot: '#FFD400', stateColor: '#8A7400' }

  // Everything else is a finding about the registry, not a fault of the card.
  return {
    state: `${passport.liveness.replace(/_/g, ' ').toLowerCase()} · ${probes}`,
    stateDot: '#FFD400',
    stateColor: '#8A7400',
  }
}

/**
 * One card per distinct agent NAME.
 *
 * The BSC registry is dominated by fleets: a single operator holds 90 of the
 * 243 agents that answer at all, every one of them registered under the same
 * name and description. Six slots filled by two operators is a true picture of
 * the registry and a useless shopfront, and a visitor reading the same card
 * twice assumes the page is broken rather than that the registry is. Ranking
 * already put the best of each fleet first, so keeping the first of each name
 * loses nothing and shows five more real agents.
 */
function oneEach(passports: readonly ProjectedPassport[]): ProjectedPassport[] {
  const seen = new Set<string>()
  const kept: ProjectedPassport[] = []
  for (const passport of passports) {
    const key = (passport.name ?? passport.agentId).trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(passport)
  }
  return kept
}

export function liveShards(passports: readonly ProjectedPassport[]): ShardSpec[] {
  return seatOccupants(
    oneEach(passports)
      .slice(0, 6)
      .map((passport) => ({
        initial: initialOf(passport.name, passport.agentId),
        name: (passport.name ?? `Agent ${passport.agentId}`).replace(/^AiKi\s+/i, ''),
        capability: capabilityOf(passport),
        ...stateOf(passport),
        ...paletteFor(passport.agentId),
      })),
  )
}
