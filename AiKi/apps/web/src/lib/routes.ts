import type { Route } from 'next'

/**
 * Typed-route escape hatch, in one place.
 *
 * `typedRoutes` cannot check a template literal, so every dynamic href would
 * otherwise need its own cast scattered through the components. Keeping them
 * here means there is exactly one file to fix if a route ever moves.
 */
export const FAST_HOME = '/app' as Route
export const agentHref = (key: string) => `/agent/${key}` as Route
/** A real agent, addressed by its ERC-8004 token id. */
export const registryHref = (agentId: string) => `/registry/${agentId}` as Route
export const hireHref = (key: string) => `/agent/${key}/hire` as Route
export const jobHref = (id: string) => `/jobs/${id}` as Route
export const receiptHref = (id: string) => `/receipts/${id}` as Route
export const route = (path: string) => path as Route
