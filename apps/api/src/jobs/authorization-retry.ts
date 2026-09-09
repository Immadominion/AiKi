import { createHash } from 'node:crypto'
import { ClientError } from '../http/errors.js'
import type { AuthorizationRecord } from './store.js'

/** Stable owner-scoped UUID. No raw operation key needs to be persisted. */
export function authorizationOperationId(owner: string | null, key: string): string {
  if (
    !owner ||
    !/^0x[0-9a-f]{40}$/i.test(owner) ||
    /^0x0{40}$/i.test(owner) ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(key)
  )
    throw new ClientError('Use a valid idempotency key and signed-in wallet for this mandate.', {
      code: 'AUTHORIZATION_IDEMPOTENCY_INVALID',
    })
  const bytes = createHash('sha256')
    .update(JSON.stringify(['aiki.authorization.v1', owner.toLowerCase(), key]))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x80
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  return JSON.stringify(typeof value === 'bigint' ? value.toString() : value) ?? 'null'
}

/** Never reset status, signatures or spent limits when a creation request is replayed. */
export function authorizationReplay(
  expected: AuthorizationRecord,
  existing: AuthorizationRecord | null,
): AuthorizationRecord {
  if (
    !existing ||
    existing.id !== expected.id ||
    existing.owner !== expected.owner ||
    canonical(existing.policy.constraints) !== canonical(expected.policy.constraints) ||
    existing.policy.weakestTier !== expected.policy.weakestTier ||
    existing.policy.expiresAt !== expected.policy.expiresAt
  )
    throw new ClientError(
      'This mandate request key was already used with different limits. Review the existing request before starting another.',
      {
        code: 'AUTHORIZATION_IDEMPOTENCY_CONFLICT',
        statusCode: 409,
      },
    )
  return existing
}
