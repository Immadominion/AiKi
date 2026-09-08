import { randomUUID } from 'node:crypto'
import type { EvidenceStore, NewObservation } from '../evidence/types.js'
import type { ProbeAgentResult } from './probe.js'
import { type MarketplaceReadiness, marketplaceReadiness } from './readiness.js'
import type { RegistrationResolution } from './registration.js'

export interface VerificationInput {
  chainId: number
  registry: string
  agentId: string
  registration: RegistrationResolution
  probe: ProbeAgentResult
  identityVerified: boolean
}

export interface VerificationPersisted {
  runId: string
  observationsInserted: number
  readiness: MarketplaceReadiness
}

function subject(input: VerificationInput) {
  return {
    type: 'agent' as const,
    chainId: input.chainId,
    registry: input.registry,
    agentId: input.agentId,
  }
}

/** Persist all conclusions and raw probe metadata as independent immutable facts. */
export async function persistVerification(
  store: EvidenceStore,
  input: VerificationInput,
): Promise<VerificationPersisted> {
  const runId = randomUUID()
  const readiness = marketplaceReadiness(input)
  const base = {
    subject: subject(input),
    validAt: input.probe.probedAt,
    observedAt: input.probe.probedAt,
    source: 'aiki:prober',
    evidenceClass: 'B' as const,
  }
  const observations: NewObservation[] = [
    {
      ...base,
      predicate: 'erc8004.registration_resolution',
      method: 'registration-resolver/v1',
      value: {
        uri: input.registration.uri,
        scheme: input.registration.scheme,
        status: input.registration.status,
        zeroCost: input.registration.zeroCost,
        detail: input.registration.detail,
        manifest: input.registration.manifest,
      },
      dedupeKey: `prober:${runId}:registration`,
    },
    {
      ...base,
      predicate: 'agent.liveness_verdict',
      method: `capability-probe/${input.probe.verdict.rule}`,
      value: {
        state: input.probe.verdict.state,
        detail: input.probe.verdict.detail,
        evidence: input.probe.verdict.evidence,
        registrationWasZeroCost: input.probe.registrationWasZeroCost,
      },
      dedupeKey: `prober:${runId}:verdict`,
    },
    {
      ...base,
      predicate: 'erc8004.reciprocal_proof',
      method: 'reciprocal-proof/D8',
      value: input.probe.reciprocal ?? { verified: false, detail: 'Not evaluated.' },
      dedupeKey: `prober:${runId}:reciprocal`,
    },
    {
      ...base,
      predicate: 'marketplace.readiness',
      method: 'marketplace-readiness/v1',
      value: readiness as unknown as Record<string, unknown>,
      dedupeKey: `prober:${runId}:readiness`,
    },
    ...input.probe.samples.map(
      (sample, index): NewObservation => ({
        ...base,
        predicate: 'agent.capability_probe',
        method: 'capability-probe/v2',
        value: sample as unknown as Record<string, unknown>,
        dedupeKey: `prober:${runId}:sample:${index}`,
      }),
    ),
  ]
  let observationsInserted = 0
  for (const observation of observations)
    if ((await store.append(observation)).inserted) observationsInserted += 1
  return { runId, observationsInserted, readiness }
}
