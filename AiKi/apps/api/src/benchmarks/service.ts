import { randomUUID } from 'node:crypto'
import { SCORING_VERSION, wilson } from '../scoring/wilson.js'
export interface BenchmarkRun {
  id: string
  scenarioId: string
  scenarioVersion: string
  forkBlock: number
  agentId: string
  baselineSuccesses: number
  agentSuccesses: number
  trials: number
  startedAt: string
  completedAt: string
  methodology: string
}
export function completeBenchmark(
  input: Omit<BenchmarkRun, 'id' | 'completedAt' | 'methodology'>,
): BenchmarkRun {
  if (
    input.trials < 1 ||
    input.agentSuccesses > input.trials ||
    input.baselineSuccesses > input.trials
  )
    throw new Error('Invalid benchmark counts.')
  return {
    ...input,
    id: randomUUID(),
    completedAt: new Date().toISOString(),
    methodology: `${SCORING_VERSION}; paired scenario; pinned BSC fork ${input.forkBlock}`,
  }
}
export function benchmarkEvidence(run: BenchmarkRun) {
  const agent = wilson(run.agentSuccesses, run.trials)
  const baseline = wilson(run.baselineSuccesses, run.trials)
  return {
    agent,
    baseline,
    deltaLower: agent.lower - baseline.upper,
    indistinguishable: agent.lower <= baseline.upper,
  }
}
