import type { EvidenceStore } from '../../evidence/types.js'
import type { GridAssessment } from './client.js'
export async function persistGridAssessment(
  store: EvidenceStore,
  input: { agentId: string; assessment: GridAssessment; registry: string; chainId: number },
) {
  return store.append({
    subject: {
      type: 'agent',
      chainId: input.chainId,
      registry: input.registry,
      agentId: input.agentId,
    },
    predicate: 'pancakeswap.grid_assessment',
    value: input.assessment as unknown as Record<string, unknown>,
    validAt: input.assessment.observedAt,
    observedAt: input.assessment.observedAt,
    source: 'aiki:reference-agent:grid',
    method: input.assessment.assessmentVersion,
    evidenceClass: 'B',
    dedupeKey: `grid:${input.agentId}:${input.assessment.pool.toLowerCase()}:${input.assessment.observedAt}`,
  })
}
