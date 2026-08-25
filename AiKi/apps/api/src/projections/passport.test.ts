import { expect, it } from 'vitest'
import type { Observation } from '../evidence/types.js'
import { comparePassports, projectPassport } from './passport.js'
import { projectStats } from './stats.js'

let seq = 0
function obs(
  agentId: string,
  predicate: string,
  value: Record<string, unknown>,
  observedAt: string,
  extra?: Partial<Observation>,
): Observation {
  seq += 1
  return {
    id: `t${seq}`,
    subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId },
    predicate,
    value,
    validAt: observedAt,
    observedAt,
    recordedAt: observedAt,
    source: 'test',
    method: 'test',
    evidenceClass: 'B',
    dedupeKey: `t${seq}`,
    ...extra,
  }
}

it('projects checks from every verdict but state from the latest', () => {
  const rows = [
    obs('7', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-01T00:00:00Z'),
    obs('7', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-02T00:00:00Z'),
    obs(
      '7',
      'agent.liveness_verdict',
      { state: 'DEGRADED', detail: 'slow' },
      '2026-01-03T00:00:00Z',
    ),
  ]
  const passport = projectPassport('7', rows)
  expect(passport.liveness).toBe('DEGRADED')
  expect(passport.livenessDetail).toBe('slow')
  expect(passport.checks).toEqual({ successes: 2, trials: 3 })
  expect(passport.components.liveness).toEqual({ successes: 2, trials: 3 })
  expect(passport.components.executionReliability).toBeNull()
  expect(passport.insufficientEvidence).toBe(true)
  expect(passport.lastProbeAt).toBe('2026-01-03T00:00:00Z')
})

it('assembles identity from chain registration, resolution, and reciprocal proof', () => {
  const rows = [
    obs(
      '9',
      'erc8004.agent_registered',
      { owner: '0xabc', agentURI: 'https://a.example/agent.json' },
      '2026-01-01T00:00:00Z',
      { evidenceClass: 'A', blockNumber: 100 },
    ),
    obs(
      '9',
      'erc8004.registration_resolution',
      {
        uri: 'https://a.example/agent.json',
        status: 'resolved',
        zeroCost: false,
        manifest: { name: 'Alpha' },
      },
      '2026-01-02T00:00:00Z',
    ),
    obs('9', 'erc8004.reciprocal_proof', { verified: true }, '2026-01-02T00:00:00Z'),
  ]
  const passport = projectPassport('9', rows)
  expect(passport.name).toBe('Alpha')
  expect(passport.identity.owner).toBe('0xabc')
  expect(passport.identity.createdAt).toBe('2026-01-01T00:00:00Z')
  expect(passport.identity.registrationFile).toEqual({
    resolved: true,
    uriScheme: 'https',
    reciprocalProofVerified: true,
    zeroCost: false,
  })
})

it('derives risks from evidence and never from absence alone', () => {
  const impostor = projectPassport('3', [
    obs(
      '3',
      'agent.liveness_verdict',
      { state: 'IMPOSTOR_STATIC', detail: 'same bytes' },
      '2026-01-01T00:00:00Z',
    ),
    obs(
      '3',
      'erc8004.registration_resolution',
      { uri: 'data:application/json,{}', status: 'resolved', zeroCost: true },
      '2026-01-01T00:00:00Z',
    ),
  ])
  expect(impostor.risks.map((r) => r.code)).toEqual(['impostor_static', 'zero_cost_registration'])
  expect(impostor.risks[0]?.severity).toBe('critical')
  expect(impostor.risks[0]?.detail).toBe('same bytes')

  const liveUnproven = projectPassport('4', [
    obs('4', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-01T00:00:00Z'),
  ])
  expect(liveUnproven.risks.map((r) => r.code)).toEqual(['no_reciprocal_proof'])

  // A dead endpoint's missing reciprocal proof is noise, not a listed risk.
  const unreachable = projectPassport('5', [
    obs('5', 'agent.liveness_verdict', { state: 'UNREACHABLE' }, '2026-01-01T00:00:00Z'),
  ])
  expect(unreachable.risks.map((r) => r.code)).toEqual(['unreachable'])

  expect(projectPassport('6', []).risks).toEqual([])
})

it('reports p95 latency from probe samples', () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    obs('8', 'agent.capability_probe', { latencyMs: (i + 1) * 10 }, '2026-01-01T00:00:00Z'),
  )
  expect(projectPassport('8', rows).p95LatencyMs).toBe(190)
  expect(projectPassport('8', []).p95LatencyMs).toBeNull()
})

it('projects stats counting each agent once by its latest verdict', () => {
  const rows = [
    obs('1', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-01T00:00:00Z'),
    obs('1', 'agent.liveness_verdict', { state: 'UNREACHABLE' }, '2026-01-05T00:00:00Z'),
    obs('2', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-02T00:00:00Z'),
    obs(
      '3',
      'erc8004.agent_registered',
      { owner: '0xabc', agentURI: 'ipfs://x' },
      '2026-01-03T00:00:00Z',
      {
        evidenceClass: 'A',
        blockNumber: 4321,
      },
    ),
  ]
  const stats = projectStats(rows)
  expect(stats.probed.agentsProbed).toBe(2)
  expect(stats.probed.byState).toEqual({ UNREACHABLE: 1, LIVE: 1 })
  expect(stats.probed.lastProbeSweepAt).toBe('2026-01-05T00:00:00Z')
  // Indexed derives only from chain-indexer evidence, never probe rows.
  expect(stats.indexed).toEqual({
    totalAgents: 1,
    bscAgents: 1,
    lastIndexedBlock: 4321,
    lastIndexedAt: '2026-01-03T00:00:00Z',
  })
  // Feedback is not ingested, so reputation is null — zeros would be a claim.
  expect(stats.reputation).toBeNull()
})

it('never fabricates: probe-only stores have null indexed, empty stores null timestamps', () => {
  const probeOnly = projectStats([
    obs('1', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-01T00:00:00Z'),
  ])
  expect(probeOnly.indexed).toBeNull()
  const empty = projectStats([])
  expect(empty.probed.lastProbeSweepAt).toBeNull()
  expect(empty.probed.agentsProbed).toBe(0)
  expect(projectPassport('9', []).updatedAt).toBeNull()
})

it('leaves reciprocal proof null when never evaluated, and words the risk as absence', () => {
  const unevaluated = projectPassport('4', [
    obs('4', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-01T00:00:00Z'),
  ])
  expect(unevaluated.identity.registrationFile.reciprocalProofVerified).toBeNull()
  const risk = unevaluated.risks.find((r) => r.code === 'no_reciprocal_proof')
  expect(risk?.detail).toContain('could not verify')

  const evaluated = projectPassport('4', [
    obs('4', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-01T00:00:00Z'),
    obs(
      '4',
      'erc8004.reciprocal_proof',
      { verified: false, detail: 'The file names another agent.' },
      '2026-01-01T00:00:00Z',
    ),
  ])
  expect(evaluated.identity.registrationFile.reciprocalProofVerified).toBe(false)
  expect(evaluated.risks.find((r) => r.code === 'no_reciprocal_proof')?.detail).toBe(
    'The file names another agent.',
  )
})

it('reads zero-cost registration from the verdict when no resolution was stored', () => {
  const passport = projectPassport('5', [
    obs(
      '5',
      'agent.liveness_verdict',
      { state: 'DECLARED_ONLY', registrationWasZeroCost: true },
      '2026-01-01T00:00:00Z',
    ),
  ])
  expect(passport.identity.registrationFile.zeroCost).toBe(true)
  expect(passport.risks.some((r) => r.code === 'zero_cost_registration')).toBe(true)
})

it('never merges evidence across registries that share a tokenId', () => {
  const rows = [
    obs('7', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-01T00:00:00Z'),
    obs('7', 'agent.liveness_verdict', { state: 'LIVE' }, '2026-01-02T00:00:00Z'),
    obs('7', 'agent.liveness_verdict', { state: 'IMPOSTOR_STATIC' }, '2026-01-03T00:00:00Z', {
      subject: { type: 'agent', chainId: 1, registry: '0xother', agentId: '7' },
    }),
  ]
  const passport = projectPassport('7', rows)
  expect(passport.checks.trials).toBe(2)
  expect(passport.liveness).toBe('LIVE')
  expect(passport.registry).toBe('0x8004')
})

it('keeps two tied agents tied even when a third is clearly worse', () => {
  const mk = (interval: [number, number]) =>
    ({ proofScore: { interval } }) as unknown as Parameters<typeof comparePassports>[0][number]
  expect(
    comparePassports([mk([0.5, 0.8]), mk([0.6, 0.9]), mk([0.05, 0.2])]).indistinguishable,
  ).toBe(true)
  expect(comparePassports([mk([0.5, 0.8]), mk([0.05, 0.2])]).indistinguishable).toBe(false)
})
