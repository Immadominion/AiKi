import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'
import { isForbiddenAddress } from '../net/guard.js'
import { CatalogError } from './types.js'

export type CatalogFetch = (url: URL, init: RequestInit) => Promise<Response>

const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const specialV6 = new BlockList()
specialV6.addSubnet('2001::', 23, 'ipv6')
specialV6.addSubnet('2002::', 16, 'ipv6')
specialV6.addSubnet('3fff::', 20, 'ipv6')

export function isPublicDestination(address: string): boolean {
  if (isForbiddenAddress(address)) return false
  // Disallow IPv4-compatible/NAT translation/transition forms and reserved IPv6,
  // even when their printable representation does not resemble a private IPv4.
  return (
    isIP(address) !== 6 || (globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6'))
  )
}

export function safeEndpoint(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CatalogError(
      422,
      'UNSAFE_ENDPOINT',
      'The registered endpoint is not a safe HTTPS URL.',
    )
  }
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 2048
  ) {
    throw new CatalogError(422, 'UNSAFE_ENDPOINT', 'Only public HTTPS endpoints are supported.')
  }
  return url
}

/**
 * Pin the checked DNS address into the actual TLS connection. No second DNS lookup,
 * no redirects, no ambient cookies/proxy credentials, and no shared connection pool.
 * TLS still verifies the original registered hostname, not the pinned IP address.
 */
export const publicFetch: CatalogFetch = async (input, init) => {
  const url = safeEndpoint(input.href)
  const signal = init.signal ?? AbortSignal.timeout(12_000)
  signal.throwIfAborted()
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let onAbort = () => {}
  const addresses = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    }),
  ]).finally(() => signal.removeEventListener('abort', onAbort))
  signal.throwIfAborted()
  if (!addresses.length || addresses.some((entry) => !isPublicDestination(entry.address))) {
    throw new CatalogError(422, 'UNSAFE_ENDPOINT', 'The registered endpoint is not public.')
  }
  const pinned = addresses[0]
  if (!pinned) throw new CatalogError(422, 'UNSAFE_ENDPOINT', 'No public endpoint address.')
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        hostname: pinned.address,
        family: pinned.family,
        servername: host,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: { ...Object.fromEntries(new Headers(init.headers)), host: url.host },
        agent: false,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 502
        if (status < 200 || status > 599) {
          res.destroy()
          reject(
            new CatalogError(
              502,
              'INVALID_HTTP_STATUS',
              'The provider returned an invalid HTTP status.',
            ),
          )
          return
        }
        if (status >= 300 && status < 400) {
          res.destroy()
          reject(
            new CatalogError(
              422,
              'ENDPOINT_REDIRECT',
              'Redirected endpoints need a new registration URL.',
            ),
          )
          return
        }
        try {
          const headers = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(', ') : value)
          }
          const body = [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
          resolve(new Response(body, { status, headers }))
        } catch {
          res.destroy()
          reject(
            new CatalogError(
              502,
              'INVALID_HTTP_RESPONSE',
              'The provider returned an invalid HTTP response.',
            ),
          )
        }
      },
    )
    req.once('error', reject)
    req.end(typeof init.body === 'string' ? init.body : undefined)
  })
}

export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new CatalogError(502, 'RESPONSE_TOO_LARGE', 'The provider response is too large.')
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        throw new CatalogError(502, 'RESPONSE_TOO_LARGE', 'The provider response is too large.')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
