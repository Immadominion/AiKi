import type {
  StrategyAuthorizationPreparation,
  StrategyPublicConfig,
  StrategySetupInput,
  StrategySetupView,
  StrategyWalletActionRequest,
} from '@aiki/contracts/strategies'
import { apiRequest } from '@/lib/api'

const post = <T>(path: string, body?: unknown, key?: string) =>
  apiRequest<T>(path, {
    method: 'POST',
    // apiRequest attaches application/json; Fastify rejects an empty JSON payload before routing.
    body: JSON.stringify(body ?? null),
    ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
  })
const path = (id: string) => `/v1/strategies/${encodeURIComponent(id)}`
export const strategyApi = {
  config: () => apiRequest<StrategyPublicConfig>('/v1/strategies/config'),
  list: () => apiRequest<{ setups: StrategySetupView[] }>('/v1/strategies'),
  detail: (id: string) => apiRequest<StrategySetupView>(path(id)),
  prepare: (input: StrategySetupInput, gasLimitWei: string, key: string) =>
    post<StrategySetupView>('/v1/strategies/prepare', { input, gasLimitWei }, key),
  prepareAction: (id: string, input: StrategyWalletActionRequest, key: string) =>
    post<StrategySetupView>(`${path(id)}/actions/prepare`, input, key),
  submitAction: (id: string, actionId: string, transactionHash: string) =>
    post<StrategySetupView>(`${path(id)}/actions/${encodeURIComponent(actionId)}/submit`, {
      transactionHash,
    }),
  finalizeAction: (id: string, actionId: string) =>
    post<StrategySetupView>(`${path(id)}/actions/${encodeURIComponent(actionId)}/finalize`),
  prepareAuthorization: (id: string) =>
    post<StrategyAuthorizationPreparation>(`${path(id)}/authorization/prepare`),
  fileAuthorization: (id: string, signature: string) =>
    post<StrategySetupView>(`${path(id)}/authorization`, { signature }),
  start: (id: string) => post<StrategySetupView>(`${path(id)}/start`),
  pause: (id: string) => post<StrategySetupView>(`${path(id)}/pause`),
  recover: (id: string) => post<StrategySetupView>(`${path(id)}/recover`),
}
