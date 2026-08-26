import type { Observation } from '../evidence/types.js'

/**
 * The price an agent publishes in its own registration, in base units.
 *
 * Returns null when the agent publishes none, which is the common case: almost
 * nothing in the registry declares a price. Null is the honest answer and the
 * caller has to handle it, because the alternative is quoting zero and letting
 * a user authorise a payment against a number nobody stated.
 */
export function publishedPrice(agentId: string, observations: Observation[]): bigint | null {
  const registration = observations
    .filter(
      (o) => o.subject.agentId === agentId && o.predicate === 'erc8004.registration_resolution',
    )
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]

  const manifest = registration?.value.manifest as
    | { pricing?: { amount?: unknown; asset?: unknown } }
    | undefined
  const amount = manifest?.pricing?.amount
  if (typeof amount === 'string' && /^\d+$/.test(amount)) return BigInt(amount)
  if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0)
    return BigInt(amount)
  return null
}
