import type { EvidenceStore } from '../../evidence/types.js'
import type { YieldAssessment } from './client.js'
export async function persistYieldAssessment(
  store: EvidenceStore,
  input: { agentId: string; assessment: YieldAssessment; registry: string; chainId: number },
) {
  return store.append({
    subject: {
      type: 'agent',
      chainId: input.chainId,
      registry: input.registry,
      agentId: input.agentId,
    },
    predicate: 'yield.route_assessment',
    value: input.assessment as unknown as Record<string, unknown>,
    validAt: input.assessment.observedAt,
    observedAt: input.assessment.observedAt,
    source: 'aiki:reference-agent:yield',
    method: input.assessment.assessmentVersion,
    evidenceClass: 'B',
    dedupeKey: `yield:${input.agentId}:${input.assessment.observedAt}`,
  })
}
