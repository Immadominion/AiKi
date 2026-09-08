import type { EvidenceStore, NewObservation } from '../../evidence/types.js'
import type { VenusHealthAssessment } from './types.js'

export async function persistVenusAssessment(
  store: EvidenceStore,
  input: { agentId: string; assessment: VenusHealthAssessment; registry: string; chainId: number },
): Promise<number> {
  const base = {
    subject: {
      type: 'agent' as const,
      chainId: input.chainId,
      registry: input.registry,
      agentId: input.agentId,
    },
    validAt: input.assessment.observedAt,
    observedAt: input.assessment.observedAt,
    source: 'aiki:reference-agent:venus',
    evidenceClass: 'B' as const,
  }
  const observations: NewObservation[] = [
    {
      ...base,
      predicate: 'venus.health_factor_assessment',
      method: input.assessment.assessmentVersion,
      value: input.assessment as unknown as Record<string, unknown>,
      dedupeKey: `venus:${input.agentId}:assessment:${input.assessment.observedAt}`,
    },
    ...input.assessment.positions.map((position) => ({
      ...base,
      predicate: 'venus.position_snapshot',
      method: input.assessment.assessmentVersion,
      value: { account: input.assessment.account, status: input.assessment.status, ...position },
      dedupeKey: `venus:${input.agentId}:position:${input.assessment.account.toLowerCase()}:${position.vToken.toLowerCase()}:${input.assessment.observedAt}`,
    })),
  ]
  let inserted = 0
  for (const observation of observations)
    if ((await store.append(observation)).inserted) inserted += 1
  return inserted
}
