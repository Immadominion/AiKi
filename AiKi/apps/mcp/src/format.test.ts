import type { ProjectedPassport } from '@aiki/contracts'
import { expect, it } from 'vitest'
import { EVIDENCE_CAVEAT, passportDetail, passportLine } from './format.js'

/**
 * These assert on wording, which is unusual and is the point.
 *
 * A tool result is read by a language model and then paraphrased to a person.
 * Anything a caveat depends on has to survive that paraphrase, so the caveat has
 * to sit next to the number rather than in a footer the model may drop.
 */

const passport = (over: Partial<ProjectedPassport> = {}): ProjectedPassport =>
  ({
    agentId: '42',
    chainId: 56,
    registry: '0x8004',
    name: 'Venus Guardian',
    liveness: 'LIVE',
    livenessDetail: null,
    lastProbeAt: '2026-08-30T00:00:00.000Z',
    p95LatencyMs: 210,
    proofScore: {
      value: 0.82,
      confidence: 0.9,
      interval: [0.6, 0.94],
      sampleSize: 9,
      method: 'wilson',
    },
    checks: { successes: 9, trials: 11 },
    components: {
      liveness: { successes: 9, trials: 9 },
      executionReliability: null,
      outcomeQuality: null,
      reputation: null,
      safety: null,
    },
    identity: {
      tokenId: '42',
      owner: '0xabc',
      createdAt: null,
      registrationFile: {
        resolved: true,
        uriScheme: 'https',
        reciprocalProofVerified: true,
        zeroCost: true,
      },
    },
    risks: [],
    evidence: [],
    updatedAt: '2026-08-30T00:00:00.000Z',
    insufficientEvidence: false,
    ...over,
  }) as ProjectedPassport

it('never states a score without the sample size beside it', () => {
  // "0.82" invites "82% reliable". "0.82 from 9 checks" does not, because the
  // number that makes it weak is sitting next to it.
  const line = passportLine(passport())
  expect(line).toContain('0.82')
  expect(line).toContain('9 checks')

  const detail = passportDetail(passport())
  const scoreLine = detail.split('\n').find((l) => l.startsWith('Proof score'))
  expect(scoreLine).toContain('9 checks')
  expect(scoreLine).toContain('0.60–0.94')
})

it('says a score with no checks behind it is not a score', () => {
  const line = passportLine(
    passport({
      proofScore: { value: 0, confidence: 0, interval: [0, 0], sampleSize: 0, method: 'wilson' },
    }),
  )
  expect(line).toContain('no score yet')
  expect(line).not.toContain('0.00')
})

it('leads with the warning when there is not enough evidence', () => {
  const detail = passportDetail(passport({ insufficientEvidence: true }))
  expect(detail).toMatch(/does not hold enough observations/)
  // Before the numbers, so a model summarising the top of the block carries it.
  expect(detail.indexOf('does not hold enough')).toBeLessThan(detail.indexOf('Proof score'))
})

it('calls a missing reciprocal proof absent rather than leaving it blank', () => {
  const detail = passportDetail(
    passport({
      identity: {
        ...passport().identity,
        registrationFile: {
          resolved: true,
          uriScheme: 'https',
          reciprocalProofVerified: false,
          zeroCost: true,
        },
      },
    }),
  )
  expect(detail).toContain('ABSENT')
})

it('distinguishes never-evaluated from evaluated-and-failed', () => {
  const detail = passportDetail(
    passport({
      identity: {
        ...passport().identity,
        registrationFile: {
          resolved: true,
          uriScheme: 'https',
          reciprocalProofVerified: null,
          zeroCost: null,
        },
      },
    }),
  )
  expect(detail).toContain('never evaluated')
  expect(detail).not.toContain('ABSENT')
})

it('separates never-measured components from zero successes', () => {
  // "0/0" reads as a failure; it is an absence, and an agent never measured on
  // safety must not look like one that failed every safety check.
  const detail = passportDetail(passport())
  expect(detail).toContain('safety never measured')
  expect(detail).toContain('liveness 9/9')
})

it('carries a caveat that refuses to endorse', () => {
  expect(EVIDENCE_CAVEAT).toMatch(/not endorsements/)
  expect(EVIDENCE_CAVEAT).toMatch(/bounded by a mandate/)
  expect(EVIDENCE_CAVEAT).not.toMatch(/\bbest\b|\brecommend/i)
})
