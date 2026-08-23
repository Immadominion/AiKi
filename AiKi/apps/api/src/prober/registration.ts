/** Resolve and validate an ERC-8004 registration file without trusting its self-declared identity. */

import type { DeclaredService } from './detect.js'

export type RegistrationScheme = 'https' | 'ipfs' | 'data' | 'unsupported'
export type RegistrationStatus = 'resolved' | 'invalid' | 'unreachable' | 'unsupported'

export interface RegistrationManifest {
  type?: string
  name?: string
  description?: string
  image?: string
  services: DeclaredService[]
  registrations: { agentId?: string; agentRegistry?: string }[]
  supportedTrust: string[]
  active?: boolean
}

export interface RegistrationResolution {
  uri: string
  scheme: RegistrationScheme
  status: RegistrationStatus
  manifest?: RegistrationManifest
  fetchedAt: string
  detail?: string
  /** `data:` needs no remote fetch and must never be counted as availability evidence. */
  zeroCost: boolean
}

const MAX_BYTES = 512 * 1024
const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'

function schemeFor(uri: string): RegistrationScheme {
  if (uri.startsWith('data:')) return 'data'
  if (uri.startsWith('ipfs://')) return 'ipfs'
  if (/^https:\/\//i.test(uri)) return 'https'
  return 'unsupported'
}

function declaredServices(value: unknown): DeclaredService[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    if (typeof item.endpoint !== 'string' || !item.endpoint) return []
    return [
      {
        name: typeof item.name === 'string' ? item.name : 'service',
        endpoint: item.endpoint,
        ...(typeof item.version === 'string' ? { version: item.version } : {}),
        ...(typeof item.transport === 'string' ? { transport: item.transport } : {}),
      },
    ]
  })
}

function registrationClaims(value: unknown): { agentId?: string; agentRegistry?: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const agentId =
      typeof item.agentId === 'number' || typeof item.agentId === 'string'
        ? String(item.agentId)
        : undefined
    const agentRegistry = typeof item.agentRegistry === 'string' ? item.agentRegistry : undefined
    return [{ ...(agentId ? { agentId } : {}), ...(agentRegistry ? { agentRegistry } : {}) }]
  })
}

function parseManifest(
  text: string,
): Omit<RegistrationResolution, 'uri' | 'scheme' | 'fetchedAt' | 'zeroCost'> {
  let source: unknown
  try {
    source = JSON.parse(text)
  } catch {
    return { status: 'invalid', detail: 'Registration content is not valid JSON.' }
  }
  if (!source || typeof source !== 'object')
    return { status: 'invalid', detail: 'Registration content must be a JSON object.' }
  const value = source as Record<string, unknown>
  const manifest: RegistrationManifest = {
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.image === 'string' ? { image: value.image } : {}),
    services: declaredServices(value.services),
    registrations: registrationClaims(value.registrations),
    supportedTrust: Array.isArray(value.supportedTrust)
      ? value.supportedTrust.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof value.active === 'boolean' ? { active: value.active } : {}),
  }
  if (manifest.type !== REGISTRATION_TYPE)
    return {
      status: 'invalid',
      manifest,
      detail: `Expected ERC-8004 registration-v1 type, got ${manifest.type ?? 'missing'}.`,
    }
  if (
    !manifest.name ||
    !manifest.description ||
    !manifest.image ||
    manifest.registrations.length === 0
  ) {
    return {
      status: 'invalid',
      manifest,
      detail: 'Registration-v1 is missing one or more required fields.',
    }
  }
  return { status: 'resolved', manifest }
}

function decodeDataUri(uri: string): string {
  const comma = uri.indexOf(',')
  if (comma < 0) throw new Error('Malformed data URI.')
  const header = uri.slice(0, comma)
  const body = uri.slice(comma + 1)
  return header.includes(';base64')
    ? Buffer.from(body, 'base64').toString('utf8')
    : decodeURIComponent(body)
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'application/json, application/ld+json;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_BYTES) throw new Error(`Registration exceeds ${MAX_BYTES} byte limit.`)
  return new TextDecoder().decode(body)
}

/**
 * Resolve the URI anchored onchain. Callers must never use `registrations` inside
 * the file as proof of identity; it is captured only as a claim for reconciliation.
 */
export async function resolveRegistration(
  uri: string,
  ipfsGateway = 'https://ipfs.io/ipfs/',
): Promise<RegistrationResolution> {
  const fetchedAt = new Date().toISOString()
  const scheme = schemeFor(uri)
  const zeroCost = scheme === 'data'
  if (scheme === 'unsupported')
    return {
      uri,
      scheme,
      status: 'unsupported',
      fetchedAt,
      zeroCost,
      detail: 'Only https, ipfs, and data registration URIs are supported.',
    }
  try {
    const text =
      scheme === 'data'
        ? decodeDataUri(uri)
        : await fetchText(
            scheme === 'ipfs'
              ? `${ipfsGateway.replace(/\/$/, '')}/${uri.slice('ipfs://'.length)}`
              : uri,
          )
    return { uri, scheme, fetchedAt, zeroCost, ...parseManifest(text) }
  } catch (error) {
    return {
      uri,
      scheme,
      status: 'unreachable',
      fetchedAt,
      zeroCost,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export { REGISTRATION_TYPE }
