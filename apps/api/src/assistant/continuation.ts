/** Selected API result fields only. Never carry typed data or signatures through the model. */
/**
 * Which shape the browser must verify before it asks anyone to sign.
 *
 * The review screen checks the stored mandate against an expected structure, so
 * it needs to know which structure to expect. Defaulting an absent value to the
 * Venus scope keeps every continuation stored before this existed working, and
 * fails safe: the guardian check is the stricter of the two.
 */
export type MandateScope = 'venus_repay' | 'token_transfer'

export interface MandateContinuation {
  kind: 'sign_mandate'
  scope: MandateScope
  authorizationId: string
  chainId: 56 | 97
  account: string
  manager: string
}

export function mandateContinuation(value: unknown): MandateContinuation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const action = value as Record<string, unknown>
  const address = (entry: unknown): entry is string =>
    typeof entry === 'string' && /^0x[0-9a-f]{40}$/i.test(entry) && !/^0x0{40}$/i.test(entry)
  const scope = action.scope === undefined ? 'venus_repay' : action.scope
  if (
    action.kind !== 'sign_mandate' ||
    (scope !== 'venus_repay' && scope !== 'token_transfer') ||
    typeof action.authorizationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      action.authorizationId,
    ) ||
    (action.chainId !== 56 && action.chainId !== 97) ||
    !address(action.account) ||
    !address(action.manager)
  )
    return
  return {
    kind: 'sign_mandate',
    scope,
    authorizationId: action.authorizationId.toLowerCase(),
    chainId: action.chainId,
    account: action.account.toLowerCase(),
    manager: action.manager.toLowerCase(),
  }
}

/**
 * One action the agent is waiting to be allowed to take.
 *
 * The gate has existed since approvals shipped and has only ever been
 * answerable on the job screen, which somebody working in Fast never opens. A
 * mandate that says "ask me first" and has nowhere to answer is not a safer
 * mandate, it is a dead end: the agent stops, nothing moves, and the person is
 * told to go and find a page.
 *
 * It carries ids and a network, never an amount. What is being agreed to is
 * read back from the API by the control that renders it, because a figure that
 * travelled through the model is a figure the model could have changed.
 */
export interface ApprovalContinuation {
  kind: 'answer_approval'
  jobId: string
  approvalId: string
  chainId: 56 | 97
}

export type AssistantContinuation = MandateContinuation | ApprovalContinuation | FundingContinuation

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function approvalContinuation(value: unknown): ApprovalContinuation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const action = value as Record<string, unknown>
  if (
    action.kind !== 'answer_approval' ||
    typeof action.jobId !== 'string' ||
    !UUID.test(action.jobId) ||
    typeof action.approvalId !== 'string' ||
    !UUID.test(action.approvalId) ||
    (action.chainId !== 56 && action.chainId !== 97)
  )
    return
  return {
    kind: 'answer_approval',
    jobId: action.jobId.toLowerCase(),
    approvalId: action.approvalId.toLowerCase(),
    chainId: action.chainId,
  }
}

/**
 * Where to send money so an agent has something to spend.
 *
 * The address existed and was reachable, and somebody still could not find it,
 * because it arrived as the fortieth word of a paragraph explaining what native
 * BNB is. An address is not prose. It is a thing you copy, and the only way to
 * get it wrong is to retype it.
 *
 * Carries no balance: this is the control for funding, not a readout, and a
 * permanent balance on the surface somebody works on is chrome nobody asked
 * for. It renders in the turn where funding is the question and nowhere else.
 */
export interface FundingContinuation {
  kind: 'fund_account'
  address: string
  chainId: 56 | 97
  /** What the account can actually be given. Native BNB is never one of these. */
  symbols: string[]
}

export function fundingContinuation(value: unknown): FundingContinuation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const action = value as Record<string, unknown>
  const symbols = Array.isArray(action.symbols)
    ? action.symbols.filter((entry): entry is string => typeof entry === 'string').slice(0, 4)
    : []
  if (
    action.kind !== 'fund_account' ||
    typeof action.address !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(action.address) ||
    /^0x0{40}$/i.test(action.address) ||
    (action.chainId !== 56 && action.chainId !== 97) ||
    symbols.length === 0
  )
    return
  return {
    kind: 'fund_account',
    address: action.address.toLowerCase(),
    chainId: action.chainId,
    symbols,
  }
}
