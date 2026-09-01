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

/**
 * The asset an agent publishes its price in, or null if it names none.
 *
 * Kept beside `publishedPrice` because the two are one fact. A quote settles in
 * AiKi's settlement asset whatever the agent said, so a caller has to be able to
 * check that the agent said the same thing before the number means anything: a
 * price of 100000 is ten cents in a six-decimal token and a millionth of a cent
 * in an eighteen-decimal one.
 */
export function publishedAsset(agentId: string, observations: Observation[]): string | null {
  const registration = observations
    .filter(
      (o) => o.subject.agentId === agentId && o.predicate === 'erc8004.registration_resolution',
    )
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]

  const manifest = registration?.value.manifest as { pricing?: { asset?: unknown } } | undefined
  const asset = manifest?.pricing?.asset
  return typeof asset === 'string' && asset.length > 0 ? asset : null
}
