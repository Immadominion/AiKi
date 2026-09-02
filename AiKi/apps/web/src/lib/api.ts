/**
 * API client for the AiKi backend.
 *
 * Points at the mock server by default (`pnpm mock` → :4700), so the frontend is
 * never blocked on apps/api existing. Same shapes either way — the contract is
 * the seam, and both sides build against it.
 */

import type {
  EcosystemStats,
  ProjectedPassport,
  ProjectedSearchResponse,
  SearchRequest,
} from '@aiki/contracts'

/**
 * Empty means this origin, which is how it is deployed: the app proxies /v1 to
 * the API so the session cookie is same-origin. Local development points at the
 * dev API on another port instead.
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Whether the caller should retry, per the contract's error model. */
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    // The session is an HttpOnly cookie, so it only travels when asked for.
    credentials: 'include',
    cache: 'no-store',
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string; retryable: boolean }
    } | null
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
      body?.error?.retryable ?? false,
    )
  }
  return (await res.json()) as T
}

/**
 * What the API says a single limit is actually worth.
 *
 * `tier` is decided by the API against its deployed enforcer set, never by us
 * and never by what we sent: the request carries a claimed tier on each
 * constraint and the API overwrites it. So this is the only tier a screen may
 * render. `enforcedBy` names the contract holding it, or is null with `why`
 * explaining what stopped it being held.
 */
export interface EnforcedLimit {
  kind: string
  label: string
  tier: 'T0' | 'T2'
  enforcedBy: string | null
  why: string
}

export interface Enforcement {
  /** The weakest link, never an average. */
  tier: 'T0' | 'T2'
  /**
   * Which chain is doing the refusing. Load-bearing: "the chain refuses this"
   * reads as a sentence about real money, and on a test network it is not one.
   */
  network: string | null
  audited: boolean
  limits: EnforcedLimit[]
}

export interface AuthorizationResponse {
  id: string
  status: string
  spent: string
  owner: string | null
  policy: { hash: string; weakestTier: string }
  enforcement?: Enforcement
}

export interface Watch {
  jobId: string
  account: string
  chainId: number
  protocol: string
  minimumHealthFactor: string
  asset: string
  market: string
  status: 'active' | 'stopped'
  createdAt: string
  lastCheckedAt?: string
  lastActedAt?: string
  lastReason?: string
  /** Base units of the asset still available under the mandate. */
  remaining?: string | null
}

export interface AssistantStep {
  tool: string
  input: Record<string, unknown>
  ok: boolean
  /** Did it change something, or only look? */
  mutating: boolean
}

export interface TaskSummary {
  id: string
  poster: string
  authorizationId?: string
  title: string
  brief: string
  kind: string
  pricePoints: number
  feePoints: number
  totalPoints: number
  /** Base units of the settlement asset, as a string: a uint256 is not a number. */
  outlay: string
  status: 'OPEN' | 'CLAIMED' | 'SUBMITTED' | 'SETTLED' | 'CANCELLED' | 'DISPUTED'
  claimedBy?: string
  claimedAt?: string
  /** Set when this was hired from one named agent rather than posted openly. */
  assignedAgentId?: string
  /** When AiKi called that agent, and what happened if the call did not work. */
  dispatchedAt?: string
  dispatchNote?: string
  workHours: number
  /** When the claim lapses and the work goes back on the board. */
  claimExpiresAt?: string
  /** When the poster runs out of time and the claimant may take the payment. */
  reviewExpiresAt?: string
  submission?: string
  submittedAt?: string
  resolution?: string
  createdAt: string
  updatedAt: string
}

export interface Seller {
  address: string
  name: string
  blurb: string
  kinds: string[]
  ratePoints: number
  available: boolean
  updatedAt: string
  /** Counted from settled work, never entered by them. */
  record: { delivered: number; disputed: number; earnedPoints: number }
}

export interface AssistantTurn {
  reply: string
  steps: AssistantStep[]
  truncated: boolean
  /** Why it stopped early, when it did. Absent when the model finished. */
  stoppedBy?: 'rounds' | 'budget'
  /**
   * `held` is what was taken before the turn ran; `points` is what it actually
   * cost. The difference went straight back, which is why the balance below is
   * read after the return rather than after the charge.
   */
  cost: { points: number; balance: number; held: number; explanation: string }
}

export interface CreditBalance {
  balance: number
  worthUsd: number
  pointsPerUsdt: number
  minimumToAsk: number
  model: string
  history: { id: string; delta: number; reason: string; createdAt: string }[]
}

export const api = {
  stats: () => req<EcosystemStats>('/v1/stats'),
  me: () => req<{ address: string; chainId: number }>('/v1/auth/me'),
  /**
   * What a mandate would be worth, without creating one. No session needed,
   * because the answer depends only on the constraints and the deployed
   * enforcers, and someone should be able to see what AiKi can enforce before
   * deciding whether to connect a wallet.
   */
  previewMandate: (constraints: unknown[]) =>
    req<Enforcement>('/v1/mandates/preview', {
      method: 'POST',
      body: JSON.stringify({ constraints }),
    }),
  /** The account this person's mandates spend from, or null if they have none. */
  account: () =>
    req<{ address: string | null; chainId: number; network: string | null }>('/v1/account'),
  /** Deploys one. AiKi pays the gas; the account belongs to the caller. */
  createAccount: () =>
    req<{ address: string; chainId: number; created: boolean }>('/v1/account', { method: 'POST' }),
  /**
   * Exactly what to sign, computed by the side that will verify it. `message` is
   * what the wallet signs; `unsigned` is what to post back, and carries the args
   * the signature deliberately does not cover.
   */
  prepareDelegation: (id: string, delegator: string) =>
    req<{
      domain: unknown
      types: unknown
      primaryType: string
      message: unknown
      unsigned: Record<string, unknown>
    }>(`/v1/authorizations/${id}/delegation?delegator=${delegator}`),
  fileDelegation: (id: string, delegation: Record<string, unknown>) =>
    req<{ id: string; delegator: string | null; delegationChainId: number | null }>(
      `/v1/authorizations/${id}/delegation`,
      { method: 'POST', body: JSON.stringify({ delegation }) },
    ),
  /** The job as the API has it, including every verdict recorded against it. */
  job: (id: string) =>
    req<{
      id: string
      status: string
      events: { type: string; at: string; detail: string }[]
    }>(`/v1/jobs/${id}`),
  /**
   * Attempt one action. Returns what the mandate said, what the chain said when
   * it was asked, and which of the two ultimately held the limit.
   */
  runAction: (
    jobId: string,
    action: { target: string; selector: string; asset: string; amount: string; callData: string },
  ) =>
    req<{
      policy: { allow: boolean; rule: string; reason: string }
      chain?: {
        status: 'landed' | 'reverted' | 'refused'
        transactionHash?: string
        revertReason?: string
      }
      heldBy: 'chain' | 'aiki'
    }>(`/v1/jobs/${jobId}/actions`, { method: 'POST', body: JSON.stringify(action) }),
  /**
   * What an agent is standing watch over, if anything.
   *
   * 404 is the ordinary answer for a job nobody has put a watch on, so callers
   * treat it as "not watched" rather than as a failure.
   */
  watch: (jobId: string) => req<Watch>(`/v1/jobs/${jobId}/watch`),
  startWatch: (
    jobId: string,
    body: {
      account: string
      chainId: number
      minimumHealthFactor: string
      asset: string
      market: string
    },
  ) => req<Watch>(`/v1/jobs/${jobId}/watch`, { method: 'POST', body: JSON.stringify(body) }),
  stopWatch: (jobId: string) => req<Watch>(`/v1/jobs/${jobId}/watch/stop`, { method: 'POST' }),
  /** Points, what they are worth, and every reason the number moved. */
  credits: () => req<CreditBalance>('/v1/credits'),
  /** Where to send USDT for points. Public: you have to see it before signing in. */
  treasury: () =>
    req<{
      available?: false
      chainId?: number
      token?: string
      treasury?: string
      pointsPerUsdt?: number
    }>('/v1/credits/treasury'),
  /** Hands over a payment's transaction hash. Everything else is read from the chain. */
  depositCredits: (transactionHash: string) =>
    req<{ points: number; balance: number; amount: string }>('/v1/credits/deposits', {
      method: 'POST',
      body: JSON.stringify({ transactionHash }),
    }),
  /**
   * One turn of Fast mode. The whole conversation goes up each time, because the
   * server holds no session state for it — a turn is priced from the tokens it
   * actually reads, so what is sent is what is paid for and both sides can see it.
   */
  assistant: (messages: { role: 'user' | 'assistant'; content: string }[]) =>
    req<AssistantTurn>('/v1/assistant/messages', {
      method: 'POST',
      body: JSON.stringify({ messages }),
    }),
  authorize: (constraints: unknown[]) =>
    req<AuthorizationResponse>('/v1/authorizations', {
      method: 'POST',
      body: JSON.stringify({ constraints }),
    }),
  revokeAuthorization: (id: string) =>
    req<AuthorizationResponse>(`/v1/authorizations/${id}/revoke`, { method: 'POST' }),
  createJob: (authorizationId: string, idempotencyKey: string) =>
    req<{ id: string; status: string }>('/v1/jobs', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ authorizationId }),
    }),
  search: (body: SearchRequest) =>
    req<ProjectedSearchResponse>('/v1/search', { method: 'POST', body: JSON.stringify(body) }),
  passport: (id: string) => req<ProjectedPassport>(`/v1/agents/${id}/passport`),
  /**
   * Two or more agents side by side, plus the server's own verdict on whether
   * the evidence can separate them. `indistinguishable` is the answer the
   * product exists to be able to give.
   */
  /** What one run of this agent costs, priced from what the agent publishes. */
  quote: (agentId: string) =>
    req<{
      quoteId: string
      agentId: string
      price: { amount: string; asset: string; decimals: number; assetAddress?: string }
      platformFee: { amount: string; asset: string; decimals: number }
      total: { amount: string; asset: string; decimals: number }
      settlementAsset: { symbol: string; address: string; decimals: number }
      feeBasisPoints: number
      expiresAt: string
      priceSource: 'registration' | 'owner-listing'
    }>('/v1/quotes', { method: 'POST', body: JSON.stringify({ agentId }) }),
  /**
   * Work somebody posted and funded, that anybody may claim.
   *
   * The other shape of trade. A hire picks a listed agent and pays its published
   * price; a task is work nobody has listed, funded before it is visible, that
   * whoever can do it takes. It is the only way an agent can buy something from
   * a person, because a person has no listing and no URL that answers a probe.
   */
  tasks: () => req<{ kinds: Record<string, string>; tasks: TaskSummary[] }>('/v1/tasks'),
  myTasks: () => req<{ tasks: TaskSummary[] }>('/v1/tasks/mine'),
  task: (id: string) => req<TaskSummary>(`/v1/tasks/${id}`),
  postTask: (task: {
    title: string
    brief: string
    kind: string
    pricePoints: number
    workHours?: number
    authorizationId?: string
    /** Hire this one agent instead of opening the work to whoever claims it. */
    assignAgentId?: string
    /** Or hire this one person, by address. */
    hirePerson?: string
  }) =>
    req<TaskSummary & { heldPoints: number }>('/v1/tasks', {
      method: 'POST',
      body: JSON.stringify(task),
    }),
  claimTask: (id: string) => req<TaskSummary>(`/v1/tasks/${id}/claim`, { method: 'POST' }),
  submitTask: (id: string, submission: string) =>
    req<TaskSummary>(`/v1/tasks/${id}/submit`, {
      method: 'POST',
      body: JSON.stringify({ submission }),
    }),
  acceptTask: (id: string) =>
    req<TaskSummary & { paidTo: string; paidPoints: number; feePoints: number }>(
      `/v1/tasks/${id}/accept`,
      { method: 'POST' },
    ),
  declineTask: (id: string, because: string) =>
    req<TaskSummary & { note: string }>(`/v1/tasks/${id}/decline`, {
      method: 'POST',
      body: JSON.stringify({ because }),
    }),
  /** People listed as available for work, with what each has actually delivered. */
  sellers: () => req<{ kinds: Record<string, string>; sellers: Seller[] }>('/v1/sellers'),
  seller: (address: string) => req<Seller>(`/v1/sellers/${address}`),
  /** Create or change your own listing. Keyed on your session, never anybody else's. */
  putSeller: (listing: {
    name: string
    blurb: string
    kinds: string[]
    ratePoints: number
    available: boolean
  }) => req<Seller>('/v1/sellers/me', { method: 'PUT', body: JSON.stringify(listing) }),
  /** Take payment for work the poster never answered. Only after the review window. */
  releaseTask: (id: string) =>
    req<TaskSummary & { paidTo: string; paidPoints: number }>(`/v1/tasks/${id}/release`, {
      method: 'POST',
    }),
  cancelTask: (id: string) =>
    req<TaskSummary & { refundedPoints: number }>(`/v1/tasks/${id}/cancel`, { method: 'POST' }),
  /**
   * What the agent is waiting to be allowed to do.
   *
   * Amounts arrive as strings and stay strings. A uint256 is not a JSON number,
   * and this is the screen where somebody agrees to one, so the last digits of
   * what they are agreeing to must not be lost to a float.
   */
  approvals: (jobId: string) =>
    req<{
      jobId: string
      approvals: {
        id: string
        target: string
        selector: string
        asset: string
        amount: string
        reason: string
        status: 'pending' | 'approved' | 'declined' | 'used'
        requestedAt: string
        decidedAt?: string
      }[]
    }>(`/v1/jobs/${jobId}/approvals`),
  /**
   * Say yes or no to one waiting action.
   *
   * Answering does not make it happen. The agent's next check finds the answer
   * and acts on it, which is why every sentence around this says "next time it
   * checks" rather than claiming the thing is done.
   */
  decideApproval: (jobId: string, approvalId: string, decision: 'approved' | 'declined') =>
    req<{ id: string; status: string; amount: string }>(
      `/v1/jobs/${jobId}/approvals/${approvalId}`,
      { method: 'POST', body: JSON.stringify({ decision }) },
    ),
  /** Take the quoted total from the buyer. Nothing reaches the agent yet. */
  fundJob: (jobId: string, agentId: string) =>
    req<{ jobId: string; held: number; buyerBalance: number; status: string }>(
      `/v1/jobs/${jobId}/fund`,
      { method: 'POST', body: JSON.stringify({ agentId }) },
    ),
  /** Pay the agent's owner and keep the fee that was quoted. */
  settleJob: (jobId: string, agentId: string) =>
    req<{
      jobId: string
      paidTo: string
      paidToAgent: number
      fee: number
      alreadySettled: boolean
      status: string
    }>(`/v1/jobs/${jobId}/settle`, { method: 'POST', body: JSON.stringify({ agentId }) }),
  /** The supply side: the owner sets what AiKi quotes for their agent. */
  listAgent: (agentId: string, priceAmount: string) =>
    req<{ agentId: string; listedBy: string; price: { amount: string; asset: string } }>(
      `/v1/agents/${agentId}/listing`,
      { method: 'POST', body: JSON.stringify({ priceAmount }) },
    ),
  compare: (agentIds: string[]) =>
    req<{ agents: ProjectedPassport[]; indistinguishable: boolean; reason: string }>(
      '/v1/compare',
      {
        method: 'POST',
        body: JSON.stringify({ agentIds }),
      },
    ),
}
