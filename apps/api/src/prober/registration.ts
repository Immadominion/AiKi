/** Resolve and validate an ERC-8004 registration file without trusting its self-declared identity. */

import { guardedFetch } from '../net/guard.js'
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
  /**
   * What the agent says one call costs, in base units of `asset`.
   *
   * This parser is a whitelist, so a field it does not name is dropped. Pricing
   * was not named, which made `publishedPrice` unable to return anything but
   * null for every agent on the chain: `/v1/quotes` refused every hire with
   * AGENT_HAS_NO_PUBLISHED_PRICE, and no registration file could have changed
   * that, because the number never survived resolution. Quoting is the second
   * half of "find an agent and hire it", so the field has to come through.
   */
  pricing?: { amount?: string; asset?: string }
}

/**
 * A price is kept only in the exact shape a payment can be authorised against:
 * an integer count of base units, plus the asset those units are in. Anything
 * else is dropped rather than coerced, because a price that has been guessed at
 * is worse than no price at all.
 */
function declaredPricing(value: unknown): { amount?: string; asset?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { amount, asset } = value as { amount?: unknown; asset?: unknown }
  const normalised =
    typeof amount === 'string' && /^\d+$/.test(amount)
      ? amount
      : typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0
        ? String(amount)
        : undefined
  if (normalised === undefined) return undefined
  return { amount: normalised, ...(typeof asset === 'string' ? { asset } : {}) }
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
const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/'
const FALLBACK_IPFS_GATEWAY = 'https://dweb.link/ipfs/'
const IPFS_ATTEMPT_MS = 5_000
const IPFS_TOTAL_MS = 10_000
// Fixed gateway hosts only; separate injected transports do not share state.
// This is process-local courtesy, not a distributed quota or availability claim.
const gatewayCooldowns = new WeakMap<typeof guardedFetch, Map<string, number>>()

class RegistrationReadError extends Error {}
class GatewayHttpError extends RegistrationReadError {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`HTTP ${status}`)
  }
}

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

/**
 * Exported because it is the pure half of resolution: everything that decides
 * what a registration file MEANS, with no network in it. Resolution can only be
 * tested against a live host; this can be tested against a string.
 */
export function parseManifest(
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
  const pricing = declaredPricing(value.pricing)
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
    ...(pricing ? { pricing } : {}),
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

/**
 * ipfs://<CID>[/path…] with a strict charset, so the path can never smuggle
 * traversal or query segments into the gateway URL we build from it.
 */
function ipfsGatewayPath(uri: string): string {
  const rest = uri.slice('ipfs://'.length)
  const segments = rest.split('/')
  const cid = segments[0] ?? ''
  if (!/^[A-Za-z0-9]{20,}$/.test(cid)) throw new RegistrationReadError('Malformed ipfs CID.')
  for (const seg of segments.slice(1)) {
    if (!/^[A-Za-z0-9._-]+$/.test(seg) || seg === '..' || seg === '.')
      throw new RegistrationReadError('Malformed ipfs path.')
  }
  return segments.join('/')
}

async function fetchText(
  url: string,
  read: typeof guardedFetch,
  timeoutMs = 15_000,
): Promise<string> {
  // guardedFetch validates every hop against private address space; the
  // registry is permissionless, so this URL is attacker input by definition.
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadlineError = () => new RegistrationReadError('Registration fetch deadline exceeded.')
  const active = () => {
    if (controller.signal.aborted) throw deadlineError()
  }
  if (timeoutMs <= 0) throw deadlineError()
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(deadlineError())
      }, timeoutMs)
      timer.unref?.()
    })
    return await Promise.race([
      (async () => {
        const response = await read(url, {
          headers: { accept: 'application/json, application/ld+json;q=0.9' },
          signal: controller.signal,
        })
        if (controller.signal.aborted || !response.ok) {
          void response.body?.cancel().catch(() => {})
          active()
          throw new GatewayHttpError(response.status, response.headers.get('retry-after'))
        }
        reader = response.body?.getReader()
        if (!reader) return ''
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          active()
          const { done, value } = await reader.read()
          active()
          if (done) break
          total += value.byteLength
          if (total > MAX_BYTES)
            throw new RegistrationReadError(`Registration exceeds ${MAX_BYTES} byte limit.`)
          chunks.push(value)
        }
        return new TextDecoder().decode(Buffer.concat(chunks))
      })(),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
}

function retryAt(header: string | null): number {
  const now = Date.now()
  const seconds = header && /^\d+$/.test(header.trim()) ? Number(header) : NaN
  const requested = Number.isFinite(seconds) ? now + seconds * 1_000 : Date.parse(header ?? '')
  // Missing, invalid or past Retry-After still gets at least a minute of relief.
  return Number.isFinite(requested) ? Math.max(now + 60_000, requested) : now + 60_000
}

async function fetchIpfs(
  uri: string,
  gateway: string,
  read: typeof guardedFetch,
): Promise<{ text: string; detail?: string }> {
  const path = ipfsGatewayPath(uri)
  const deadline = Date.now() + IPFS_TOTAL_MS
  // IPFS path gateway format: https://docs.ipfs.tech/how-to/address-ipfs-on-web/
  // Both fixed public gateways receive exactly the same CID/path. This is HTTP
  // retrieval, not independent content-hash verification or provider evidence.
  const gateways =
    gateway === DEFAULT_IPFS_GATEWAY ? [DEFAULT_IPFS_GATEWAY, FALLBACK_IPFS_GATEWAY] : [gateway]
  let cooldowns = gatewayCooldowns.get(read)
  if (!cooldowns) {
    cooldowns = new Map()
    gatewayCooldowns.set(read, cooldowns)
  }
  for (const current of gateways) {
    const host = new URL(current).origin
    if ((cooldowns.get(host) ?? 0) > Date.now()) continue
    try {
      const text = await fetchText(
        `${current.replace(/\/$/, '')}/${path}`,
        read,
        Math.min(IPFS_ATTEMPT_MS, deadline - Date.now()),
      )
      return {
        text,
        ...(gateways.length === 2 && current === FALLBACK_IPFS_GATEWAY
          ? {
              detail:
                'Registration retrieved via dweb.link after ipfs.io rate limiting. This fetch is not provider endpoint availability evidence.',
            }
          : {}),
      }
    } catch (error) {
      // Only explicit gateway throttling permits the fixed alternate. In
      // particular, do not bypass authentication, SSRF blocks, malformed JSON,
      // oversized bodies, timeouts, or ambiguous transport failures.
      if (!(error instanceof GatewayHttpError) || error.status !== 429) throw error
      cooldowns.set(host, retryAt(error.retryAfter))
    }
  }
  throw new RegistrationReadError(
    'IPFS gateways are rate limited; registration remains unresolved.',
  )
}

/**
 * Resolve the URI anchored onchain. Callers must never use `registrations` inside
 * the file as proof of identity; it is captured only as a claim for reconciliation.
 */
export async function resolveRegistration(
  uri: string,
  ipfsGateway = DEFAULT_IPFS_GATEWAY,
  read: typeof guardedFetch = guardedFetch,
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
    const retrieval =
      scheme === 'data'
        ? { text: decodeDataUri(uri) }
        : scheme === 'ipfs'
          ? await fetchIpfs(uri, ipfsGateway, read)
          : { text: await fetchText(uri, read) }
    return {
      uri,
      scheme,
      fetchedAt,
      zeroCost,
      ...('detail' in retrieval ? { detail: retrieval.detail } : {}),
      ...parseManifest(retrieval.text),
    }
  } catch (error) {
    return {
      uri,
      scheme,
      status: 'unreachable',
      fetchedAt,
      zeroCost,
      detail:
        error instanceof RegistrationReadError
          ? error.message
          : 'Registration content could not be fetched or decoded safely.',
    }
  }
}

export { REGISTRATION_TYPE }
