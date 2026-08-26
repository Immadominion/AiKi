export interface ProbeCandidate {
  agentId: string
  chainId: number
  registry: string
  agentUri: string
  /** Null when this agent has never been probed. */
  lastProbedAt: string | null
}

export interface SweepOptions {
  /** How many agents to probe at once. Third-party servers are not ours to hammer. */
  concurrency: number
  /** Stop starting new work after this many milliseconds, so a scheduled run ends. */
  budgetMs: number
  now?: () => number
}

export interface SweepResult {
  probed: number
  failed: number
  /** Candidates the budget ran out on. Reported, never silently dropped. */
  skipped: number
  observationsInserted: number
  failures: { agentId: string; error: string }[]
}

/**
 * One pass of the prober over agents that are due.
 *
 * Written against callbacks rather than a store and a network so the parts that
 * decide things can be tested without either. Three properties matter: a single
 * hostile or broken agent must not end the sweep, the run must stop when its
 * budget does rather than when the registry does, and whatever it could not
 * reach must be counted rather than quietly dropped, because an unprobed agent
 * is a gap in our coverage and the product's whole claim is that we say so.
 */
export async function runProbeSweep(
  candidates: ProbeCandidate[],
  probeOne: (candidate: ProbeCandidate) => Promise<number>,
  options: SweepOptions,
): Promise<SweepResult> {
  const now = options.now ?? Date.now
  const deadline = now() + options.budgetMs
  const result: SweepResult = {
    probed: 0,
    failed: 0,
    skipped: 0,
    observationsInserted: 0,
    failures: [],
  }

  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency, candidates.length)) },
    async () => {
      while (true) {
        const index = next++
        const candidate = candidates[index]
        if (!candidate) return
        if (now() >= deadline) {
          result.skipped += 1
          continue
        }
        try {
          // Read-modify-write must not straddle the await: `x += await f()`
          // reads x first, so two workers can both read the same value and one
          // increment is lost. The await completes before anything is written.
          const inserted = await probeOne(candidate)
          result.observationsInserted += inserted
          result.probed += 1
        } catch (error) {
          result.failed += 1
          // Capped: a registry-wide outage would otherwise build a failure list
          // as long as the registry itself.
          if (result.failures.length < 20)
            result.failures.push({
              agentId: candidate.agentId,
              error: error instanceof Error ? error.message : String(error),
            })
        }
      }
    },
  )

  await Promise.all(workers)
  return result
}
