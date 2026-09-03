import { createHash } from 'node:crypto'
import type { JsonValue } from './model.js'

type CanonicalBudget = { nodes: number }

function canonical(value: JsonValue, budget: CanonicalBudget, depth: number): string {
  budget.nodes += 1
  if (budget.nodes > 20_000 || depth > 64)
    throw new TypeError('Canonical JSON exceeds the supported complexity limit.')
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON cannot contain a non-finite number.')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonical(entry, budget, depth + 1)).join(',')}]`
  const entries = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, budget, depth + 1)}`)
  return `{${entries.join(',')}}`
}

export function canonicalJson(value: JsonValue): string {
  return canonical(value, { nodes: 0 }, 0)
}

export function hashCanonicalJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
