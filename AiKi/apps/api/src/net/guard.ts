/**
 * Outbound fetch guard for URLs we do not choose.
 *
 * The registry is permissionless, so every agentURI and every declared endpoint
 * is attacker-controlled input to OUR outbound HTTP client. Without this guard,
 * registering an agent whose URL points at 169.254.169.254 or an internal
 * service turns the prober into a free SSRF proxy that then stores the response
 * as "registration content".
 *
 * The guard: resolve the hostname, reject any address in a non-public range,
 * and never follow a redirect without re-validating the hop. Validation runs at
 * lookup time, so a DNS-rebinding race between lookup and connect remains
 * possible in a narrow window; closing it fully needs address pinning via a
 * custom undici Agent, which is a dispatcher-level change left deliberately to
 * the owner of this package.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Expand an IPv6 string into eight 16-bit words, or null if malformed. */
function v6Words(ip: string): number[] | null {
  // Strip a zone index (fe80::1%eth0) before parsing.
  const bare = ip.split('%')[0] ?? ip
  const halves = bare.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two words.
  const expand = (parts: string[]): number[] | null => {
    const out: number[] = []
    for (const p of parts) {
      if (p.includes('.')) {
        const v4 = p.split('.').map(Number)
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0))
      } else {
        const n = Number.parseInt(p || '0', 16)
        if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null
        out.push(n)
      }
    }
    return out
  }
  const h = expand(head)
  const t = expand(tail)
  if (!h || !t) return null
  const missing = 8 - h.length - t.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  return [...h, ...Array.from({ length: missing }, () => 0), ...t]
}

function forbiddenV4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return true
  const [a = 0, b = 0] = parts
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 192 && b === 0) return true // 192.0.0/24 + 192.0.2/24 doc
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51) return true // 198.51.100/24 doc
  if (a === 203 && b === 0) return true // 203.0.113/24 doc
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

/** True when the address must never be a prober destination. Pure, testable. */
export function isForbiddenAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return forbiddenV4(ip)
  if (family !== 6) return true
  const w = v6Words(ip)
  if (!w) return true
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = w
  const isZero = w.every((x) => x === 0)
  if (isZero) return true // ::
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1)
    return true // ::1
  if ((w0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((w0 & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((w0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (w0 === 0x2001 && w1 === 0x0db8) return true // 2001:db8::/32 doc
  // v4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): re-check the embedded v4.
  const embedded =
    (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) ||
    (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0)
  if (embedded) return forbiddenV4(`${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`)
  return false
}

export class ForbiddenDestinationError extends Error {
  constructor(host: string) {
    super(`Refusing to fetch ${host}: resolves to a non-public address.`)
    this.name = 'ForbiddenDestinationError'
  }
}

/** Resolve the URL's host and throw unless every address it maps to is public. */
export async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new ForbiddenDestinationError(url.protocol)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // Literals skip DNS; everything else must have every A/AAAA answer public,
  // because the resolver, not us, picks which one the socket uses.
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0) throw new ForbiddenDestinationError(url.hostname)
  for (const a of addresses) {
    if (isForbiddenAddress(a.address)) throw new ForbiddenDestinationError(url.hostname)
  }
}

const MAX_REDIRECTS = 3

/**
 * fetch() that validates the destination of every hop. Redirects are followed
 * manually because undici's `follow` would happily glide from a public host
 * into a private one.
 */
export async function guardedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input)
  for (let hop = 0; ; hop++) {
    await assertPublicHost(url)
    const res = await fetch(url, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    const location = res.headers.get('location')
    if (!location) return res
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}).`)
    res.body?.cancel()
    url = new URL(location, url)
  }
}
