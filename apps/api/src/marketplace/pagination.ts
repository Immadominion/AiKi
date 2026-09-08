import { MarketplaceError } from './errors.js'

export type PageCursor = Readonly<{ createdAt: string; id: string }>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeCursor(value: string | undefined): PageCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown
      id?: unknown
    }
    if (
      typeof parsed.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string' ||
      !UUID.test(parsed.id)
    )
      throw new Error('invalid cursor payload')
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id }
  } catch {
    throw new MarketplaceError('INVALID_CURSOR', 'That page cursor is invalid.', {
      statusCode: 400,
    })
  }
}
