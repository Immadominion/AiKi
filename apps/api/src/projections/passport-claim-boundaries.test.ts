import { expect, it } from 'vitest'
import type { Observation } from '../evidence/types.js'
import { d1_impostorStatic, type ProbeSample } from '../prober/detect.js'
import { projectPassport } from './passport.js'

function observation(state: string, extra: Record<string, unknown> = {}): Observation {
  const at = new Date().toISOString()
  return {
    id: 'claim-boundary',
    subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: '3' },
    predicate: 'agent.liveness_verdict',
    value: { state, ...extra },
    validAt: at,
    observedAt: at,
    recordedAt: at,
    source: 'test',
    method: 'test',
    evidenceClass: 'B',
    dedupeKey: 'claim-boundary',
  }
}

it('inline metadata is not described as a free mint or proof of a fake agent', () => {
  const passport = projectPassport('3', [
    observation('UNPROBED', { registrationWasZeroCost: true }),
  ])
  const risk = passport.risks.find((item) => item.code === 'zero_cost_registration')
  expect(risk?.label).toBe('Inline registration metadata')
  expect(risk?.detail).toMatch(/no remote fetch/)
  expect(risk?.detail).toMatch(/does not establish/)
  expect(risk?.detail).not.toMatch(/free to mint|sybil-cheap|cost nothing/)
  expect(passport.identity.registrationFile.zeroCost).toBe(true)
  expect(passport.liveness).toBe('UNPROBED')
})

it('identical response labels retain the failed check without alleging impersonation', () => {
  const passport = projectPassport('3', [observation('IMPOSTOR_STATIC', { detail: 'same bytes' })])
  expect(passport.risks[0]?.label).toBe('Identical responses across checked URLs')
  expect(passport.risks[0]?.detail).toBe('same bytes')
  expect(passport.risks[0]?.severity).toBe('critical')
  expect(passport.liveness).toBe('IMPOSTOR_STATIC')
})

it('a missing declaration does not claim that a service has never answered', () => {
  const passport = projectPassport('3', [observation('DECLARED_ONLY')])
  expect(passport.risks[0]?.label).toBe('No service endpoint declared')
  expect(passport.risks[0]?.label).not.toMatch(/never/)
})

it('D1 reports identical inputs without claiming the provider is not an agent', () => {
  const samples: ProbeSample[] = (['valid', 'nonsense', 'nonNumeric'] as const).map((label) => ({
    label,
    url: `https://provider.example/${label}`,
    status: 200,
    bodyHash: '12345678901234567890123456789012',
    bodyLength: 120,
    contentType: 'application/json',
    latencyMs: 20,
  }))
  const verdict = d1_impostorStatic(samples)
  expect(verdict?.state).toBe('IMPOSTOR_STATIC')
  expect(verdict?.rule).toBe('D1')
  expect(verdict?.detail).toMatch(/byte-identical responses/)
  expect(verdict?.detail).toMatch(/does not establish/)
  expect(verdict?.detail).not.toMatch(/not an agent|posing as|fake/)
  expect(verdict?.evidence?.inputsTried).toEqual(['valid', 'nonsense', 'nonNumeric'])
})
