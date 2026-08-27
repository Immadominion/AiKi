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

export interface AuthorizationResponse {
  id: string
  status: string
  spent: string
  owner: string | null
  policy: { hash: string; weakestTier: string }
}

export const api = {
  stats: () => req<EcosystemStats>('/v1/stats'),
  me: () => req<{ address: string; chainId: number }>('/v1/auth/me'),
  authorize: (constraints: unknown[]) =>
    req<AuthorizationResponse>('/v1/authorizations', {
      method: 'POST',
      body: JSON.stringify({ constraints }),
    }),
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
