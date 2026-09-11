export interface PendingFastAsk {
  text: string
  /** The first connected wallet that saw this draft. Null only before wallet selection. */
  owner: string | null
}

function normalizeOwner(address: string | null | undefined): string | null {
  const normalized = address?.trim().toLowerCase()
  return normalized || null
}

/** Read both the versioned value and the brief plain-text shape used during development. */
export function parsePendingFastAsk(raw: string | null): PendingFastAsk | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingFastAsk>
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
    if (!text) return null
    return {
      text,
      owner: typeof parsed.owner === 'string' ? normalizeOwner(parsed.owner) : null,
    }
  } catch {
    return { text: raw.trim(), owner: null }
  }
}

export function serializePendingFastAsk(draft: PendingFastAsk): string {
  return JSON.stringify({ text: draft.text, owner: normalizeOwner(draft.owner) })
}

/**
 * An anonymous draft may attach once, to the wallet selected during its handoff.
 * After that, another wallet must never inherit it.
 */
export function claimPendingFastAsk(
  draft: PendingFastAsk,
  address: string | null | undefined,
): PendingFastAsk | null {
  const owner = normalizeOwner(address)
  if (draft.owner && draft.owner !== owner) return null
  return draft.owner ? draft : { ...draft, owner }
}
