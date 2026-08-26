import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'aiki_session'
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60

export interface Session {
  address: string
  chainId: number
  /** Seconds since epoch. */
  exp: number
}

const b64url = (value: Buffer | string) => Buffer.from(value as never).toString('base64url')

/**
 * Sessions as signed tokens rather than server-side state.
 *
 * The token carries the address and its own expiry, and an HMAC over both. It
 * is a bearer credential: possession is authority, which is why it is issued
 * HttpOnly and never written anywhere JavaScript can read it.
 */
export class SessionSigner {
  private readonly secret: Buffer

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('Session secret must be at least 32 characters.')
    this.secret = Buffer.from(secret, 'utf8')
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }

  issue(address: string, chainId: number, ttlSeconds = DEFAULT_TTL_SECONDS): string {
    const session: Session = {
      address: address.toLowerCase(),
      chainId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }
    const payload = b64url(JSON.stringify(session))
    return `${payload}.${this.sign(payload)}`
  }

  /** Null for anything that is not a currently-valid token, without saying which. */
  verify(token: string | undefined): Session | null {
    if (!token) return null
    const [payload, signature] = token.split('.')
    if (!payload || !signature) return null

    const expected = Buffer.from(this.sign(payload))
    const given = Buffer.from(signature)
    // Compared in constant time, and only after a length check, since
    // timingSafeEqual throws on a length mismatch rather than returning false.
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null

    let session: Session
    try {
      session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session
    } catch {
      return null
    }
    if (typeof session.address !== 'string' || typeof session.exp !== 'number') return null
    if (session.exp * 1000 <= Date.now()) return null
    return session
  }
}

/** Minimal cookie parsing: one header, no dependency, no surprises. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: the app and the API are the same site in every
    // deployment, and Strict would drop the cookie on ordinary top-level
    // navigations back into the app.
    'SameSite=Lax',
    `Max-Age=${options.maxAge}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}
