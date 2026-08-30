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
}
