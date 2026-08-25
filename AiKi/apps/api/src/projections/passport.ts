import type { LivenessState, ProjectedPassport, ProjectedRisk } from '@aiki/contracts'
import type { Observation } from '../evidence/types.js'
import { SCORING_VERSION, wilson } from '../scoring/wilson.js'

/**
 * The passport the API serves, projected purely from stored observations.
 *
 * The wire shape lives in @aiki/contracts as ProjectedPassport, so the
 * frontend types against exactly what this file produces. Every field is
 * either backed by evidence or explicitly null. Null means "we have not
 * measured this" — never coerced to zero, because a zero is a claim and an
 * absence is not.
 */
export type PassportProjection = ProjectedPassport
export type PassportRisk = ProjectedRisk

const LIVENESS_STATES = new Set<string>([
  'LIVE',
  'DEGRADED',
  'UNREACHABLE',
  'IMPOSTOR_STATIC',
  'PLACEHOLDER_URL',
  'NOT_REMOTE',
  'DECLARED_ONLY',
  'UNPROBED',
])
export const asLiveness = (value: unknown): LivenessState =>
  typeof value === 'string' && LIVENESS_STATES.has(value) ? (value as LivenessState) : 'UNPROBED'
const latestOf = (rows: Observation[]): Observation | undefined =>
  [...rows].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]

const schemeOf = (uri: unknown): 'https' | 'ipfs' | 'data' | null => {
  if (typeof uri !== 'string') return null
  if (uri.startsWith('https:') || uri.startsWith('http:')) return 'https'
  if (uri.startsWith('ipfs:')) return 'ipfs'
  if (uri.startsWith('data:')) return 'data'
  return null
}

function deriveRisks(input: {
  state: string
  stateDetail: string | null
  zeroCost: boolean | null
  reciprocalVerified: boolean | null
  reciprocalDetail: string | null
}): PassportRisk[] {
  const risks: PassportRisk[] = []
  const probeDetail = input.stateDetail ?? 'Concluded from capability probes.'
  if (input.state === 'IMPOSTOR_STATIC')
    risks.push({
      code: 'impostor_static',
      label: 'Static page posing as an agent',
      severity: 'critical',
      detail: probeDetail,
    })
  if (input.state === 'PLACEHOLDER_URL')
    risks.push({
      code: 'placeholder_url',
      label: 'Registered URL is a placeholder',
      severity: 'critical',
      detail: probeDetail,
    })
  if (input.state === 'DECLARED_ONLY')
    risks.push({
      code: 'declared_only',
      label: 'Declares a service it has never answered for',
      severity: 'warn',
      detail: probeDetail,
    })
  if (input.state === 'UNREACHABLE')
    risks.push({
      code: 'unreachable',
      label: 'Declared endpoint does not respond',
      severity: 'warn',
      detail: probeDetail,
    })
  if (input.state === 'NOT_REMOTE')
    risks.push({
      code: 'not_remote',
      label: 'No remotely callable service',
      severity: 'warn',
      detail: probeDetail,
    })
  if (input.zeroCost === true)
    risks.push({
      code: 'zero_cost_registration',
      label: 'Registration cost nothing',
      severity: 'info',
      detail: 'A data: URI registration is free to mint, so identities like this are sybil-cheap.',
    })
  // Only meaningful when something answered: a dead endpoint failing to point
  // back at its token is noise, a live one failing to is a real gap. The claim
  // is the absence of proof, not a verified mismatch — the well-known file may
  // simply never have been readable.
  if ((input.state === 'LIVE' || input.state === 'DEGRADED') && input.reciprocalVerified !== true)
    risks.push({
      code: 'no_reciprocal_proof',
      label: 'No proof the service claims this identity',
      severity: 'warn',
      detail:
        input.reciprocalDetail ??
        'The endpoint answered, but we could not verify that it points back at this on-chain identity, so anyone could have registered this URL.',
    })
  return risks
}

export function projectPassport(agentId: string, observations: Observation[]): PassportProjection {
  // A tokenId is only unique per registry, so evidence is never merged across
  // (chain, registry) subjects that happen to share one. When more than one
  // subject matches, the best-evidenced one wins, deterministically.
  const matching = observations.filter((o) => o.subject.agentId === agentId)
  const groups = new Map<string, Observation[]>()
  for (const o of matching) {
    const key = `${o.subject.chainId}:${o.subject.registry.toLowerCase()}`
    const held = groups.get(key)
    if (held) held.push(o)
    else groups.set(key, [o])
  }
  const own =
    [...groups.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    )[0]?.[1] ?? []
  const verdicts = own.filter((o) => o.predicate === 'agent.liveness_verdict')
  const latestVerdict = latestOf(verdicts)
  const state = asLiveness(latestVerdict?.value.state)
  const successes = verdicts.filter((o) => o.value.state === 'LIVE').length
  const score = wilson(successes, verdicts.length)

  const probes = own.filter((o) => o.predicate === 'agent.capability_probe')
  const latencies = probes
    .map((o) => o.value.latencyMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)
  const p95LatencyMs = latencies.length
    ? (latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null)
    : null

  const registration = latestOf(
    own.filter((o) => o.predicate === 'erc8004.registration_resolution'),
  )
  const registered = latestOf(own.filter((o) => o.predicate === 'erc8004.agent_registered'))
  const reciprocal = latestOf(own.filter((o) => o.predicate === 'erc8004.reciprocal_proof'))
  const manifest = registration?.value.manifest as { name?: unknown } | undefined
  const reciprocalVerified = reciprocal ? reciprocal.value.verified === true : null
  const reciprocalDetail =
    typeof reciprocal?.value.detail === 'string' ? reciprocal.value.detail : null
  // The prober records the zero-cost flag both on the resolution and on the
  // verdict; either is a real measurement of the same fact.
  const zeroCost =
    typeof registration?.value.zeroCost === 'boolean'
      ? registration.value.zeroCost
      : typeof latestVerdict?.value.registrationWasZeroCost === 'boolean'
        ? latestVerdict.value.registrationWasZeroCost
        : null
  const livenessDetail =
    typeof latestVerdict?.value.detail === 'string' ? latestVerdict.value.detail : null

  const evidence = [...new Set(own.map((o) => o.predicate))].map((predicate) => {
    const rows = own.filter((o) => o.predicate === predicate)
    return {
      predicate,
      count: rows.length,
      latestAt: rows.reduce(
        (latest, row) => (row.observedAt > latest ? row.observedAt : latest),
        '',
      ),
    }
  })

  return {
    agentId,
    chainId: own[0]?.subject.chainId ?? null,
    registry: own[0]?.subject.registry ?? null,
    name: typeof manifest?.name === 'string' ? manifest.name : null,
    liveness: state,
    livenessDetail,
    lastProbeAt: latestVerdict?.observedAt ?? null,
    p95LatencyMs,
    proofScore: {
      value: score.lower,
      confidence: score.confidence,
      interval: [score.lower, score.upper],
      sampleSize: verdicts.length,
      method: SCORING_VERSION,
    },
    checks: { successes, trials: verdicts.length },
    components: {
      liveness: { successes, trials: verdicts.length },
      executionReliability: null,
      outcomeQuality: null,
      reputation: null,
      safety: null,
    },
    identity: {
      tokenId: agentId,
      owner: typeof registered?.value.owner === 'string' ? registered.value.owner : null,
      createdAt: registered?.validAt ?? null,
      registrationFile: {
        resolved: registration ? registration.value.status === 'resolved' : null,
        uriScheme:
          schemeOf(registration?.value.uri) ?? schemeOf(registered?.value.agentURI) ?? null,
        reciprocalProofVerified: reciprocalVerified,
        zeroCost,
      },
    },
    risks: deriveRisks({
      state,
      stateDetail: livenessDetail,
      zeroCost,
      reciprocalVerified,
      reciprocalDetail,
    }),
    evidence,
    updatedAt: own.length
      ? own.reduce(
          (latest, row) => (row.observedAt > latest ? row.observedAt : latest),
          own[0]?.observedAt ?? '',
        )
      : null,
    insufficientEvidence: verdicts.length < 5,
  }
}

export function comparePassports(passports: PassportProjection[]) {
  // Pairwise, not one shared intersection: two tied agents stay tied even when
  // a third, clearly-worse agent sits outside both intervals.
  const intervals = passports.map((p) => p.proofScore.interval)
  let overlapping = false
  for (let a = 0; a < intervals.length && !overlapping; a += 1)
    for (let b = a + 1; b < intervals.length && !overlapping; b += 1) {
      const [aLow, aHigh] = intervals[a] ?? [0, 0]
      const [bLow, bHigh] = intervals[b] ?? [0, 0]
      overlapping = Math.max(aLow, bLow) <= Math.min(aHigh, bHigh)
    }
  return {
    indistinguishable: overlapping,
    reason: overlapping
      ? 'At least two of these agents have overlapping confidence intervals; the evidence cannot fully rank them.'
      : undefined,
  }
}
