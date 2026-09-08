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

/**
 * The price the owner listed with AiKi, if they have.
 *
 * Separate from `publishedPrice` on purpose. A price in the registration file
 * is public: everyone who reads the agent sees the same number. A listing is
 * something the owner told AiKi, authenticated by proving they own the token.
 * Both are declarations by the same party, and they are not the same claim, so
 * a caller has to be able to tell which one it is quoting.
 */
export function listedPrice(agentId: string, observations: Observation[]): bigint | null {
  const listing = observations
    .filter((o) => o.subject.agentId === agentId && o.predicate === 'marketplace.listing')
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]

  const amount = (listing?.value.price as { amount?: unknown } | undefined)?.amount
  return typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : null
}

/**
 * What to charge, and where the number came from.
 *
 * The registration file wins when it carries a price. It is the agent's public
 * declaration, and letting a private listing quietly override a public number
 * would let an owner show the world one price and AiKi another.
 */
export function priceForQuote(
  agentId: string,
  observations: Observation[],
): { amount: bigint; source: 'registration' | 'owner-listing' } | null {
  const published = publishedPrice(agentId, observations)
  if (published !== null) return { amount: published, source: 'registration' }
  const listed = listedPrice(agentId, observations)
  if (listed !== null) return { amount: listed, source: 'owner-listing' }
  return null
}
