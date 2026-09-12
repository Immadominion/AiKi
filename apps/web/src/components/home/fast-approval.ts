import { accountTokensFor } from '@aiki/contracts/guardian'
import { formatUnits } from 'viem'
import { type ApprovalContinuation, api } from '@/lib/api'

/**
 * Answering the agent, in the place it asked.
 *
 * The approval gate has existed since the job screen shipped and has only ever
 * been answerable there, which somebody working in Fast never opens. A mandate
 * that says "ask me first" with nowhere to answer is not the safer mandate it
 * looks like: the agent stops, the money never moves, and the person is sent to
 * find a page.
 *
 * Two things this deliberately does not do. It does not take the amount from
 * the step that produced it, because that number passed through the model; it
 * reads the pending request back from the API and renders that. And approving
 * does not send. The answer is recorded, and the agent has to be asked to try
 * again, which is what the copy says rather than implying the thing has
 * happened.
 */

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** History contains data, not authority. Revalidate before offering a control. */
export function parseApprovalContinuation(value: unknown): ApprovalContinuation | null {
  const action = object(value)
  if (
    action?.kind !== 'answer_approval' ||
    typeof action.jobId !== 'string' ||
    !UUID.test(action.jobId) ||
    typeof action.approvalId !== 'string' ||
    !UUID.test(action.approvalId) ||
    (action.chainId !== 56 && action.chainId !== 97)
  )
    return null
  return {
    kind: 'answer_approval',
    jobId: action.jobId.toLowerCase(),
    approvalId: action.approvalId.toLowerCase(),
    chainId: action.chainId,
  }
}

/** Only the tool that can pause on an approval may produce one of these. */
export function approvalContinuations(steps: unknown): ApprovalContinuation[] {
  const actions = new Map<string, ApprovalContinuation>()
  for (const value of Array.isArray(steps) ? steps : []) {
    const step = object(value)
    const action =
      step?.ok === true && step.tool === 'send_token'
        ? parseApprovalContinuation(step.action)
        : null
    if (action) actions.set(action.approvalId, action)
  }
  return [...actions.values()]
}

export interface Waiting {
  /** Whole tokens where the asset is one this network reviewed, base units otherwise. */
  amount: string
  symbol: string | null
  asset: string
  recipient: string | null
  reason: string
}

export interface FastApprovalDependencies {
  approvals: typeof api.approvals
  decide: typeof api.decideApproval
}
const dependencies: FastApprovalDependencies = {
  approvals: api.approvals,
  decide: api.decideApproval,
}

export interface ApprovalSnapshot {
  phase: 'idle' | 'loading' | 'waiting' | 'answering' | 'approved' | 'declined' | 'gone'
  waiting?: Waiting
  error?: string
}

/**
 * Base units as an amount, or as itself.
 *
 * A token this network has not reviewed gets its raw base units and its address,
 * not a number invented at eighteen decimals. Guessing the scale of somebody
 * else's token is how a screen shows 0.000001 for a thousand of them.
 */
function readAmount(
  asset: string,
  amount: string,
  chainId: 56 | 97,
): { amount: string; symbol: string | null } {
  const token = accountTokensFor(chainId).find(
    (candidate) => candidate.address.toLowerCase() === asset.toLowerCase(),
  )
  if (!token) return { amount, symbol: null }
  return { amount: formatUnits(BigInt(amount), token.decimals), symbol: token.symbol }
}

export class FastApprovalController {
  private state: ApprovalSnapshot = { phase: 'idle' }
  private listeners = new Set<() => void>()
  private generation = 0
  private action: ApprovalContinuation
  constructor(
    action: ApprovalContinuation,
    private deps: FastApprovalDependencies = dependencies,
  ) {
    const checked = parseApprovalContinuation(action)
    if (!checked) throw new Error('Invalid approval continuation.')
    this.action = checked
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  dispose = () => {
    this.generation++
  }
  private update(state: ApprovalSnapshot) {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  /** Read back what is actually waiting, rather than what the step said. */
  async load() {
    if (this.state.phase === 'loading' || this.state.phase === 'answering') return
    const generation = ++this.generation
    this.update({ phase: 'loading' })
    try {
      const { approvals } = await this.deps.approvals(this.action.jobId)
      if (generation !== this.generation) return
      const found = approvals.find((entry) => entry.id === this.action.approvalId)
      if (found?.status !== 'pending') {
        /*
         * Answered somewhere else, or used. Not an error: the job screen shows
         * the same request, and two controls over one decision must agree
         * rather than both insist.
         */
        this.update({ phase: 'gone' })
        return
      }
      if (!/^\d{1,78}$/.test(found.amount)) throw new Error('unreadable amount')
      const { amount, symbol } = readAmount(found.asset, found.amount, this.action.chainId)
      this.update({
        phase: 'waiting',
        waiting: {
          amount,
          symbol,
          asset: found.asset,
          recipient: found.recipient ?? null,
          reason: found.reason,
        },
      })
    } catch {
      if (generation === this.generation)
        this.update({
          phase: 'idle',
          error: 'Could not read what is waiting. Nothing has moved. Try again.',
        })
    }
  }

  async answer(decision: 'approved' | 'declined') {
    if (this.state.phase !== 'waiting') return
    const generation = this.generation
    const { waiting } = this.state
    this.update({ phase: 'answering', ...(waiting ? { waiting } : {}) })
    try {
      await this.deps.decide(this.action.jobId, this.action.approvalId, decision)
      if (generation !== this.generation) return
      this.update({ phase: decision, ...(waiting ? { waiting } : {}) })
    } catch (error) {
      if (generation !== this.generation) return
      const message = error instanceof Error ? error.message : ''
      /*
       * The reason is worth relaying: "this was already answered" tells
       * somebody what to do next and a generic failure does not. What is never
       * left to the reason is the state of the money, which is appended every
       * time, because the one thing a person must not have to guess after a
       * failed answer is whether the send went anyway.
       */
      const relayed =
        message && message.length <= 200 && !/https?:|\n|[{}]/i.test(message)
          ? message
          : 'That answer did not go through.'
      this.update({
        phase: 'waiting',
        ...(waiting ? { waiting } : {}),
        error: `${relayed} Nothing has moved.`,
      })
    }
  }
}
