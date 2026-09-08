import type { EvidenceStore } from '../../evidence/types.js'
import type { PancakeRebalanceAssessment } from './types.js'

export async function persistPancakeAssessment(
  store: EvidenceStore,
  input: {
    agentId: string
    assessment: PancakeRebalanceAssessment
    registry: string
    chainId: number
  },
): Promise<boolean> {
  const result = await store.append({
    subject: {
      type: 'agent',
      chainId: input.chainId,
      registry: input.registry,
      agentId: input.agentId,
    },
    predicate: 'pancakeswap.rebalance_assessment',
    value: input.assessment as unknown as Record<string, unknown>,
    validAt: input.assessment.observedAt,
    observedAt: input.assessment.observedAt,
    source: 'aiki:reference-agent:pancakeswap',
    method: input.assessment.assessmentVersion,
    evidenceClass: 'B',
    dedupeKey: `pancake:${input.agentId}:position:${input.assessment.tokenId}:${input.assessment.observedAt}`,
  })
  return result.inserted
}
