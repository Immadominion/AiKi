import type { ProjectedPassport } from '@aiki/contracts'
import { type AgentTaskSupport, api } from '@/lib/api'
import type { CatalogAgent } from '@/lib/catalog-api'

type Identity = Pick<ProjectedPassport, 'agentId' | 'chainId' | 'registry'>
type Availability = Pick<AgentTaskSupport, 'available'>

/** A shared token number alone is not proof that these are the same registration. */
export function confirmedCatalogHireHref(
  agent: CatalogAgent,
  passport: Identity,
  support: Availability,
): string | null {
  if (
    support.available !== true ||
    passport.agentId !== agent.id ||
    passport.chainId !== agent.chainId ||
    !passport.registry ||
    !/^0x[a-fA-F0-9]{40}$/.test(passport.registry) ||
    passport.registry.toLowerCase() !== agent.registry.toLowerCase() ||
    agent.sourceId !== `${agent.chainId}:${agent.registry.toLowerCase()}:${agent.id}`
  )
    return null
  return `/registry/${agent.id}/hire`
}

/** Optional hiring support must fail closed without hiding the catalog/read view. */
export async function loadCatalogHireHref(
  agent: CatalogAgent,
  client: {
    passport(id: string): Promise<Identity>
    taskSupport(id: string): Promise<Availability>
  } = api,
): Promise<string | null> {
  try {
    const [passport, support] = await Promise.all([
      client.passport(agent.id),
      client.taskSupport(agent.id),
    ])
    return confirmedCatalogHireHref(agent, passport, support)
  } catch {
    return null
  }
}
