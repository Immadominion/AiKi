const CATALOG_ACTIONS = new Set(['catalog_agent', 'catalog_capabilities', 'read_external_agent'])

export function fastToolAgentHref(tool: string, id: unknown): string | undefined {
  if (typeof id !== 'string' || !/^\d{1,78}$/.test(id)) return undefined
  return `/${CATALOG_ACTIONS.has(tool) ? 'catalog' : 'registry'}/${id}`
}
