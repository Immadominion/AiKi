import type { TaskRequest } from '@/lib/api'

export const TASK_TYPES = [
  ['research', 'Research'],
  ['review', 'Review'],
  ['data', 'Data'],
  ['verify', 'Verification'],
  ['writing', 'Writing'],
  ['translation', 'Translation'],
  ['design', 'Design'],
  ['code', 'Code'],
] as const

export function taskPrice(offer: string, minimum: number, feeBasisPoints: number) {
  if (!/^\d+$/.test(offer)) throw new Error('Enter your offer as a whole number of points.')
  const amount = BigInt(offer)
  if (
    !Number.isSafeInteger(minimum) ||
    minimum < 0 ||
    !Number.isSafeInteger(feeBasisPoints) ||
    feeBasisPoints < 0 ||
    feeBasisPoints > 10_000
  ) {
    throw new Error('The task price settings could not be read. Refresh this page.')
  }
  if (amount < BigInt(minimum)) throw new Error(`Offer at least ${minimum} points.`)
  const fee = (amount * BigInt(feeBasisPoints)) / 10_000n
  const total = amount + fee
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('That offer is too large. Choose a smaller amount.')
  return { offer: Number(amount), fee: Number(fee), total: Number(total) }
}

export interface AgentTaskDraft {
  agentId: string
  title: string
  brief: string
  kind: string
  pricePoints: number
  workHours: number
  walletAddress?: string
}

export function buildAgentTask(draft: AgentTaskDraft): TaskRequest {
  const title = draft.title.trim()
  const brief = draft.brief.trim()
  if (!/^\d+$/.test(draft.agentId)) throw new Error('Choose an agent from the registry.')
  if (!title || title.length > 120) throw new Error('Add a title of up to 120 characters.')
  if (!brief) throw new Error('Describe the work and the result you want back.')
  if (!TASK_TYPES.some(([value]) => value === draft.kind)) throw new Error('Choose a type of work.')
  if (!Number.isSafeInteger(draft.pricePoints) || draft.pricePoints < 0)
    throw new Error('Enter an offer in whole points.')
  if (!Number.isInteger(draft.workHours) || draft.workHours < 1 || draft.workHours > 720)
    throw new Error('Choose a delivery time between 1 hour and 30 days.')
  const address = draft.walletAddress?.trim()
  if (draft.walletAddress !== undefined && !/^0x[\da-f]{40}$/i.test(address ?? '')) {
    throw new Error('Enter a complete 0x wallet address for the agent to read.')
  }
  const completeBrief = address ? `${brief}\n\nWallet to read (read only): ${address}` : brief
  if (completeBrief.length > 2_000)
    throw new Error(
      'Shorten your brief to fit within 2,000 characters, including the wallet address.',
    )
  return {
    title,
    brief: completeBrief,
    kind: draft.kind,
    pricePoints: draft.pricePoints,
    workHours: draft.workHours,
    assignAgentId: draft.agentId,
  }
}

export interface TaskAttempt {
  fingerprint: string
  key: string
}

/** Reuse the same operation after a lost response, never for changed work. */
export function taskAttempt(
  previous: TaskAttempt | null,
  fingerprint: string,
  createKey: () => string,
): TaskAttempt {
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: createKey() }
}

/** Refund copy uses only the confirmed API amount, never the quoted offer or task status alone. */
export function taskCreationMessage(task: {
  status: string
  submission?: string
  refundedPoints?: number
}): string {
  if (task.status === 'CANCELLED') {
    if (
      typeof task.refundedPoints === 'number' &&
      Number.isSafeInteger(task.refundedPoints) &&
      task.refundedPoints > 0
    )
      return `The agent declined. Your ${task.refundedPoints.toLocaleString()} points were refunded. See the task in Work.`
    return 'This request was cancelled. Check its refund status in Work.'
  }
  return task.submission
    ? 'Your request was delivered. Review the result in Work.'
    : 'Your request is in Work. Follow its delivery there.'
}

/** Only these API responses confirm that no points were taken for the request. */
const UNCHARGED_TASK_ERRORS: Record<string, number> = {
  INVALID_IDEMPOTENCY_KEY: 400,
  TASK_INVALID_BODY: 400,
  TASK_INCOMPLETE: 400,
  TASK_KIND_UNKNOWN: 400,
  TASK_PRICE_TOO_LOW: 400,
  TASK_PRICE_INVALID: 400,
  TASK_DURATION_INVALID: 400,
  NOT_AN_ADDRESS: 400,
  CANNOT_HIRE_YOURSELF: 400,
  ONE_SELLER: 400,
  INSUFFICIENT_POINTS: 402,
  NOT_YOUR_MANDATE: 403,
  MANDATE_REFUSED: 403,
  AGENT_NOT_HIREABLE: 422,
  AGENT_NOT_LIVE: 422,
  AGENT_TASK_PROTOCOL_UNSUPPORTED: 422,
  AGENT_HAS_NO_ENDPOINT: 422,
  TASK_IDEMPOTENCY_UNAVAILABLE: 503,
  SETTLEMENT_UNAVAILABLE: 503,
  DISPATCH_UNAVAILABLE: 503,
  HIRING_UNAVAILABLE: 503,
}

export function taskRejectedBeforeCharge(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error) || !('code' in error))
    return false
  return (
    typeof error.code === 'string' &&
    Object.hasOwn(UNCHARGED_TASK_ERRORS, error.code) &&
    UNCHARGED_TASK_ERRORS[error.code] === error.status
  )
}
