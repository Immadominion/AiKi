import type { EcosystemStats, LivenessState, ProjectedPassport } from '@aiki/contracts'

export type LandingMarketDataStatus = 'loading' | 'live' | 'fallback' | 'error'
export type LandingResourceStatus = 'loading' | 'live' | 'fallback' | 'error'

export interface LandingMarketAggregate {
  source: 'api' | 'committed-sweep'
  /** The API does not currently publish an observation count. */
  observationCount: number | null
  /** BNB Chain agents seen by the indexer, or null when no index evidence exists. */
  indexedAgents: number | null
  indexComplete: boolean
  probedAgents: number
  answeringAgents: number
  lastSweepAt: string | null
  byState: Readonly<Partial<Record<LivenessState, number>>>
}

export interface LandingAgentRisk {
  code: string
  label: string
  severity: 'info' | 'warn' | 'critical'
  detail: string
}

/**
 * One inspectable point in the landing market.
 *
 * There is deliberately no inferred category, protocol, price, artwork, or
 * position here. The projected passport does not measure those fields today.
 */
export interface LandingAgentNode {
  /** Stable across responses without pretending an agent id is globally unique. */
  id: string
  agentId: string
  chainId: number | null
  registry: string | null
  displayName: string
  hasMeasuredName: boolean
  liveness: 'LIVE' | 'DEGRADED'
  livenessDetail: string | null
  lastProbeAt: string | null
  updatedAt: string
  p95LatencyMs: number | null
  checks: {
    successes: number
    trials: number
  }
  proof: {
    /** Wilson lower bound, expressed on the API's 0 to 1 scale. */
    floor: number
    interval: readonly [number, number]
    sampleSize: number
    method: string
  }
  insufficientEvidence: boolean
  risks: readonly LandingAgentRisk[]
}

export interface LandingMarketErrors {
  aggregate: string | null
  agents: string | null
}

export interface LandingMarketData {
  status: LandingMarketDataStatus
  aggregateStatus: LandingResourceStatus
  agentsStatus: LandingResourceStatus
  aggregate: LandingMarketAggregate
  agents: readonly LandingAgentNode[]
  /** When this browser completed its latest request, not when the evidence was observed. */
  fetchedAt: string | null
  refreshing: boolean
  errors: LandingMarketErrors
  refresh: () => void
}

/**
 * Real observations committed with the repository.
 *
 * This is a cumulative projection of six AiKi probe sweeps on 20 August 2026.
 * It is only an aggregate fallback. It must never be expanded into fictional
 * individual agents, and it must not be described as the complete BNB registry.
 */
export const COMMITTED_LANDING_SWEEP: LandingMarketAggregate = {
  source: 'committed-sweep',
  observationCount: 2_490,
  indexedAgents: null,
  indexComplete: false,
  probedAgents: 1_143,
  answeringAgents: 11,
  lastSweepAt: '2026-08-20T10:25:32.066Z',
  byState: {
    LIVE: 9,
    DEGRADED: 2,
    DECLARED_ONLY: 782,
    IMPOSTOR_STATIC: 182,
    UNREACHABLE: 128,
    PLACEHOLDER_URL: 40,
  },
}

const LIVENESS_STATES: readonly LivenessState[] = [
  'LIVE',
  'DEGRADED',
  'UNREACHABLE',
  'IMPOSTOR_STATIC',
  'PLACEHOLDER_URL',
  'NOT_REMOTE',
  'DECLARED_ONLY',
  'UNPROBED',
]

const isLivenessState = (value: string): value is LivenessState =>
  LIVENESS_STATES.includes(value as LivenessState)

const count = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`The evidence API returned an invalid ${label} count.`)
  return value
}

/** Convert the public stats contract without deriving fields it does not carry. */
export function landingAggregateFromStats(stats: EcosystemStats): LandingMarketAggregate {
  const probedAgents = count(stats.probed.agentsProbed, 'probed agents')
  const byState: Partial<Record<LivenessState, number>> = {}

  for (const [state, value] of Object.entries(stats.probed.byState)) {
    if (!isLivenessState(state))
      throw new Error(`The evidence API returned an unknown liveness state: ${state}.`)
    if (value === undefined) continue
    byState[state] = count(value, state)
  }

  const answeringAgents = (byState.LIVE ?? 0) + (byState.DEGRADED ?? 0)
  if (answeringAgents > probedAgents)
    throw new Error('The evidence API returned more answering agents than probed agents.')

  return {
    source: 'api',
    observationCount: null,
    indexedAgents: stats.indexed ? count(stats.indexed.bscAgents, 'indexed BNB agents') : null,
    indexComplete: stats.indexed?.complete ?? false,
    probedAgents,
    answeringAgents,
    lastSweepAt: stats.probed.lastProbeSweepAt,
    byState,
  }
}

const safeName = (passport: ProjectedPassport): { displayName: string; measured: boolean } => {
  const measured = passport.name?.trim()
  return measured
    ? { displayName: measured, measured: true }
    : { displayName: `Agent #${passport.agentId}`, measured: false }
}

/**
 * Convert only inspectable observations into scene nodes.
 *
 * Null means this row is not safe to present as an answering agent. No fallback
 * row is created in its place.
 */
export function landingAgentNodeFromPassport(passport: ProjectedPassport): LandingAgentNode | null {
  if (passport.liveness !== 'LIVE' && passport.liveness !== 'DEGRADED') return null
  if (!passport.agentId.trim() || passport.updatedAt === null) return null
  if (
    !Number.isSafeInteger(passport.checks.trials) ||
    passport.checks.trials < 1 ||
    !Number.isSafeInteger(passport.checks.successes) ||
    passport.checks.successes < 0 ||
    passport.checks.successes > passport.checks.trials
  )
    return null

  const name = safeName(passport)
  const registry = passport.registry?.toLowerCase() ?? null

  return {
    id: `${passport.chainId ?? 'unknown'}:${registry ?? 'unknown'}:${passport.agentId}`,
    agentId: passport.agentId,
    chainId: passport.chainId,
    registry,
    displayName: name.displayName,
    hasMeasuredName: name.measured,
    liveness: passport.liveness,
    livenessDetail: passport.livenessDetail,
    lastProbeAt: passport.lastProbeAt,
    updatedAt: passport.updatedAt,
    p95LatencyMs: passport.p95LatencyMs,
    checks: {
      successes: passport.checks.successes,
      trials: passport.checks.trials,
    },
    proof: {
      floor: passport.proofScore.value,
      interval: [passport.proofScore.interval[0], passport.proofScore.interval[1]],
      sampleSize: passport.proofScore.sampleSize,
      method: passport.proofScore.method,
    },
    insufficientEvidence: passport.insufficientEvidence,
    risks: passport.risks.map((risk) => ({ ...risk })),
  }
}

/**
 * Deterministic evidence-first order, matching the registry screen.
 * This is not a popularity or performance ranking.
 */
export function landingAgentNodesFromPassports(
  passports: readonly ProjectedPassport[],
): LandingAgentNode[] {
  return passports
    .map(landingAgentNodeFromPassport)
    .filter((node): node is LandingAgentNode => node !== null)
    .sort(
      (a, b) =>
        (a.liveness === 'LIVE' ? 0 : 1) - (b.liveness === 'LIVE' ? 0 : 1) ||
        b.checks.trials - a.checks.trials ||
        a.agentId.localeCompare(b.agentId, undefined, { numeric: true }),
    )
}
