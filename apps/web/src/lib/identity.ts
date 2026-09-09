/** Stable identity, independent of render order, browser or random state. */
export function identitySeed(value: string): number {
  let hash = 2166136261
  for (const character of value.trim().toLowerCase()) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Remote artwork never becomes HTML, a local app request or an executable URI. */
export function safeAvatarUrl(value?: string | null): string | undefined {
  if (!value || value.length > 2048 || /[\s\\]/.test(value)) return undefined
  const candidate = value.startsWith('ipfs://')
    ? `https://ipfs.io/ipfs/${value.slice(7).replace(/^ipfs\//, '')}`
    : value
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
    const host = url.hostname.toLowerCase()
    if (
      !host.includes('.') ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^[\d.]+$/.test(host) ||
      host.includes(':')
    )
      return undefined
    return url.href
  } catch {
    return undefined
  }
}

export function briefText(value: string, limit = 140): string {
  const text = value
    .replace(/\u2014/g, ', ')
    .replace(/0x[0-9a-fA-F]{40}\b/g, (address) => `${address.slice(0, 6)}…${address.slice(-4)}`)
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const boundary = cut.lastIndexOf(' ')
  return `${cut.slice(0, boundary > limit * 0.6 ? boundary : cut.length).trimEnd()}…`
}
