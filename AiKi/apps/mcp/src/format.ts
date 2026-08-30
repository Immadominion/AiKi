import type { ProjectedPassport } from '@aiki/contracts'

/**
 * Turning evidence into sentences a model will relay accurately.
 *
 * A tool result gets read by a language model and then paraphrased to a person,
 * so anything a caveat depends on has to survive being summarised. Two rules
 * follow from that, and both are the opposite of what makes a nice API response.
 *
 * Say the sample size next to the score, every time. "0.82" invites "this agent
 * is 82% reliable"; "0.82 from 9 checks" does not, because the number that makes
 * it weak is sitting beside it.
 *
 * Never emit a bare superlative. This is a marketplace with a financial
 * incentive to rank things, and a model that reads "best" will repeat "best".
 * The tools describe what was measured and let the model draw the conclusion,
 * which is also the only honest thing to do with evidence this thin.
 */

const pct = (n: number) => `${Math.round(n * 100)}%`

const counts = (c: { successes: number; trials: number } | null) =>
  !c || c.trials === 0 ? 'never measured' : `${c.successes}/${c.trials}`

export function passportLine(p: ProjectedPassport): string {
  const name = p.name ?? `agent ${p.agentId}`
  const score = p.proofScore.sampleSize
    ? `${p.proofScore.value.toFixed(2)} from ${p.proofScore.sampleSize} checks`
    : 'no score yet'
  return `${name} (id ${p.agentId}) — ${p.liveness}, proof ${score}`
}

export function passportDetail(p: ProjectedPassport): string {
  const lines: string[] = []
  lines.push(`${p.name ?? 'Unnamed agent'} — id ${p.agentId} on chain ${p.chainId ?? '?'}`)
  lines.push(`Liveness: ${p.liveness}${p.livenessDetail ? ` — ${p.livenessDetail}` : ''}`)
  lines.push(
    `Last probed: ${p.lastProbeAt ?? 'never'}${p.p95LatencyMs ? ` · p95 ${p.p95LatencyMs}ms` : ''}`,
  )

  if (p.insufficientEvidence)
    lines.push(
      'AiKi does not hold enough observations of this agent to say anything useful about it yet. Treat the numbers below as a starting point, not a verdict.',
    )

  lines.push(
    `Proof score: ${p.proofScore.value.toFixed(2)} (${pct(p.proofScore.confidence)} confidence, ` +
      `range ${p.proofScore.interval[0].toFixed(2)}–${p.proofScore.interval[1].toFixed(2)}, ` +
      `${p.proofScore.sampleSize} checks, ${p.proofScore.method})`,
  )
  lines.push(`Answered as an agent: ${counts(p.checks)}`)
  lines.push(
    `  liveness ${counts(p.components.liveness)} · execution ${counts(p.components.executionReliability)} · ` +
      `outcomes ${counts(p.components.outcomeQuality)} · reputation ${counts(p.components.reputation)} · ` +
      `safety ${counts(p.components.safety)}`,
  )

  const id = p.identity
  lines.push(
    `Registration: ${id.registrationFile.resolved ? 'resolved' : 'not resolved'}` +
      (id.registrationFile.uriScheme ? ` over ${id.registrationFile.uriScheme}` : '') +
      `, reciprocal proof ${
        id.registrationFile.reciprocalProofVerified === null
          ? 'never evaluated'
          : id.registrationFile.reciprocalProofVerified
            ? 'verified'
            : 'ABSENT'
      }`,
  )
  if (id.owner) lines.push(`Owner: ${id.owner}`)

  if (p.risks.length)
    lines.push(`Risks: ${p.risks.map((r) => `${r.label} [${r.severity}]`).join('; ')}`)

  if (p.evidence.length)
    lines.push(`Evidence held: ${p.evidence.map((e) => `${e.predicate} x${e.count}`).join(', ')}`)

  lines.push(`Last updated: ${p.updatedAt ?? 'never'}`)
  return lines.join('\n')
}

/**
 * What every discovery answer ends with.
 *
 * AiKi probes agents; it does not vouch for them, and it has never watched most
 * of them handle money. A model reading a list of scores will otherwise fill
 * that gap in with a recommendation, because that is what a marketplace usually
 * hands it.
 */
export const EVIDENCE_CAVEAT =
  'These are measurements, not endorsements. AiKi probed these agents from the outside; ' +
  'a high score means it answered correctly when asked, not that it will handle money well. ' +
  'Anything it is allowed to spend should be bounded by a mandate regardless of its score.'

export const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] })
