import type { Observation } from '../evidence/types.js'
import { SCORING_VERSION, wilson } from '../scoring/wilson.js'
export interface PassportProjection {
  agentId: string
  liveness: string
  proofScore: {
    value: number
    confidence: number
    interval: [number, number]
    sampleSize: number
    method: string
  }
  evidence: { predicate: string; count: number; latestAt: string }[]
  updatedAt: string
  insufficientEvidence: boolean
}
export function projectPassport(agentId: string, observations: Observation[]): PassportProjection {
  const own = observations.filter((o) => o.subject.agentId === agentId)
  const liveness = [...own]
    .filter((o) => o.predicate === 'agent.liveness_verdict')
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
  const state = typeof liveness?.value.state === 'string' ? liveness.value.state : 'UNPROBED'
  const trials = own.filter((o) => o.predicate === 'agent.liveness_verdict')
  const successes = trials.filter((o) => o.value.state === 'LIVE').length
  const score = wilson(successes, trials.length)
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
    liveness: state,
    proofScore: {
      value: score.lower,
      confidence: score.confidence,
      interval: [score.lower, score.upper],
      sampleSize: trials.length,
      method: SCORING_VERSION,
    },
    evidence,
    updatedAt: own.reduce(
      (latest, row) => (row.observedAt > latest ? row.observedAt : latest),
      new Date(0).toISOString(),
    ),
    insufficientEvidence: trials.length < 5,
  }
}
export function comparePassports(passports: PassportProjection[]) {
  const intervals = passports.map((p) => p.proofScore.interval)
  const overlapping =
    intervals.length > 1 &&
    Math.max(...intervals.map((i) => i[0])) <= Math.min(...intervals.map((i) => i[1]))
  return {
    indistinguishable: overlapping,
    reason: overlapping ? 'Confidence intervals overlap; more evidence is required.' : undefined,
  }
}
