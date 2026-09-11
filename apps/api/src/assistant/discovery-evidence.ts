const scopes: Record<string, string> = {
  search_agents: 'aiki_index_search',
  agent_passport: 'one_indexed_identity',
  ecosystem_stats: 'aiki_index_statistics',
  agent_task_support: 'aiki_task_integration',
  catalog_agents: 'external_registration_page',
  catalog_agent: 'one_external_registration',
  catalog_capabilities: 'one_provider_capability_check',
}

const capabilityMeaning: Record<string, string> = {
  available: 'discovery_succeeded',
  auth_required: 'authentication_required',
  payment_required: 'payment_required',
  unsupported: 'connector_unsupported',
  unavailable: 'check_failed',
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Interpretation only. No new lookup, permission, eligibility decision or rewritten error. */
export function withDiscoveryEvidence<T extends { ok: boolean; body: unknown }>(
  tool: string,
  result: T,
): T {
  const scope = Object.hasOwn(scopes, tool) ? scopes[tool] : undefined
  if (!scope || !record(result.body)) return result
  const body = { ...result.body }
  const failed = !result.ok || Boolean(body.error)
  const status = typeof body.status === 'string' ? body.status : ''
  const discoveryEvidence: Record<string, unknown> = {
    scope,
    exhaustive: false,
    providerAvailability: failed
      ? 'lookup_failed_not_provider_outage'
      : tool === 'catalog_capabilities'
        ? Object.hasOwn(capabilityMeaning, status)
          ? capabilityMeaning[status]
          : 'not_verified'
        : 'not_checked',
  }
  if (tool === 'ecosystem_stats') {
    discoveryEvidence.currentCounts =
      !failed && record(body.probed) && record(body.probed.currentByState)
        ? 'probed.currentByState'
        : 'not_supplied'
    discoveryEvidence.storedLatestCounts = 'probed.byState_including_stale'
  }
  if (tool === 'agent_passport') discoveryEvidence.registrationCost = 'storage_not_authenticity'
  if (tool === 'catalog_capabilities') {
    discoveryEvidence.readToolsMeaning = 'aiki_allowlist_not_provider_toolset'
    discoveryEvidence.tradingAuthority = 'not_granted'
  }
  // Keep this small server-authored field first so long publisher metadata cannot
  // overwrite it or push it beyond the runner's bounded tool-result excerpt.
  delete body.discoveryEvidence
  return { ...result, body: { discoveryEvidence, ...body } }
}
