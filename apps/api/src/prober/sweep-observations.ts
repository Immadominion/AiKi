import type { NewObservation } from '../evidence/types.js'

/**
 * Turning a committed probe sweep into observations.
 *
 * No `id` is set. The store assigns a UUID, and the id column IS a uuid: setting
 * a readable string here worked against the in-memory store and was rejected by
 * Postgres, which is the sort of divergence a store interface is supposed to
 * prevent and this one quietly permitted. `dedupeKey` is the stable identity,
 * and it is what makes re-seeding a no-op.
 *
 * Shared by the dev server and the production seeder, so what you develop
 * against is exactly what a fresh deployment is loaded with. Each row keeps the
 * time the probe was actually taken rather than the time it was loaded, because
 * the whole point of an observation is when it was observed.
 */
export interface SweepResult {
  agentId: string
  probedAt: string
  registrationWasZeroCost?: boolean
  verdict: { state: string; rule: string; detail: string; evidence?: Record<string, unknown> }
  samples?: Record<string, unknown>[]
  reciprocal?: { verified: boolean; detail: string }
}

export interface SweepFile {
  sweptAt?: string
  chainId?: number
  registry?: string
  results?: SweepResult[]
}

function fromSweep(sweep: SweepFile): NewObservation[] {
  if (!Array.isArray(sweep.results)) return []
  const out: NewObservation[] = []
  for (const result of sweep.results) {
    if (
      !result?.agentId ||
      typeof result.verdict?.state !== 'string' ||
      typeof result.probedAt !== 'string' ||
      Number.isNaN(Date.parse(result.probedAt))
    )
      continue

    const subject = {
      type: 'agent' as const,
      chainId: sweep.chainId ?? 56,
      registry: sweep.registry ?? '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
      agentId: result.agentId,
    }
    const base = {
      subject,
      validAt: result.probedAt,
      observedAt: result.probedAt,
      recordedAt: result.probedAt,
      source: 'aiki:prober',
      evidenceClass: 'B' as const,
    }
    // The same probe run never lands twice, even when sweeps overlap.
    const runKey = `${result.agentId}:${result.probedAt}`

    out.push({
      ...base,
      predicate: 'agent.liveness_verdict',
      method: `capability-probe/${result.verdict.rule}`,
      value: {
        state: result.verdict.state,
        detail: result.verdict.detail,
        evidence: result.verdict.evidence,
        // Only stored when the sweep measured it; a missing flag is not false.
        ...(typeof result.registrationWasZeroCost === 'boolean'
          ? { registrationWasZeroCost: result.registrationWasZeroCost }
          : {}),
      },
      dedupeKey: `prober:${runKey}:verdict`,
    })

    if (result.reciprocal)
      out.push({
        ...base,
        predicate: 'erc8004.reciprocal_proof',
        method: 'reciprocal-proof/D8',
        value: result.reciprocal as unknown as Record<string, unknown>,
        dedupeKey: `prober:${runKey}:reciprocal`,
      })

    for (const [index, sample] of (result.samples ?? []).entries())
      out.push({
        ...base,
        predicate: 'agent.capability_probe',
        method: 'capability-probe/v2',
        value: sample,
        dedupeKey: `prober:${runKey}:sample:${index}`,
      })
  }
  return out
}

export function sweepObservations(files: { name: string; raw: string }[]): NewObservation[] {
  const observations: NewObservation[] = []
  for (const file of files) {
    let sweep: SweepFile
    try {
      sweep = JSON.parse(file.raw) as SweepFile
    } catch {
      continue
    }
    observations.push(...fromSweep(sweep))
  }
  const unique = new Map(observations.map((o) => [o.dedupeKey, o]))
  return [...unique.values()]
}
