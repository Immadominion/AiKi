/**
 * Which conversation Home opens with.
 *
 * The open conversation lived only in the URL. Clicking anything in the sidebar
 * and coming back therefore landed on an empty composer, because the URL Home
 * was pushed with had no conversation on it: the thread was never lost, but
 * there was no way back to it except History, and nothing said so. Somebody
 * who steps away to look at an agent they were told about reasonably expects to
 * return to the sentence they were in the middle of.
 *
 * So the last thread is remembered per wallet, with the time it was last
 * touched, and reopened on the way back. It is not remembered forever. Coming
 * back the next day is a new thought, and dropping someone into a stale thread
 * they have to read to remember is worse than a clean screen. The cutoff below
 * is the line between stepping away and coming back another time.
 */
export const AWAY_BEFORE_NEW_MS = 12 * 60 * 60 * 1000
export const LAST_CHAT_KEY = 'aiki.fast.lastChat'

export interface RememberedChat {
  id: string
  owner: string
  at: number
}

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)

export function parseRememberedChat(raw: string | null): RememberedChat | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const { id, owner, at } = value as Record<string, unknown>
    if (!isUuid(id) || typeof owner !== 'string' || !owner) return null
    if (typeof at !== 'number' || !Number.isFinite(at)) return null
    return { id, owner, at }
  } catch {
    return null
  }
}

/**
 * The thread to reopen, or null for a clean screen.
 *
 * A remembered thread belongs to one wallet. Restoring it for a different
 * address would show somebody another person's conversation on a shared
 * machine, so the owner has to match exactly.
 */
export function chatToResume(
  remembered: RememberedChat | null,
  owner: string | null,
  now = Date.now(),
): string | null {
  if (!remembered || !owner) return null
  if (remembered.owner.toLowerCase() !== owner.toLowerCase()) return null
  const age = now - remembered.at
  // A clock that has gone backwards says nothing useful about how long it has
  // been, and treating a negative age as "just now" would pin a stale thread
  // open forever.
  if (age < 0 || age > AWAY_BEFORE_NEW_MS) return null
  return remembered.id
}

export const serializeRememberedChat = (chat: RememberedChat) => JSON.stringify(chat)
