export interface InlinePart {
  kind: 'text' | 'strong' | 'em' | 'code' | 'link'
  text: string
  offset: number
  href?: string
}

export type MessageBlock =
  | { kind: 'paragraph' | 'heading' | 'code'; text: string; offset: number }
  | { kind: 'list'; ordered: boolean; start: number; items: string[]; offset: number }

/** Assistant output is untrusted. Only ordinary web links and local routes are clickable. */
export function safeMessageHref(value: string): string | undefined {
  if (/\s|\\/.test(value)) return undefined
  const local = value.startsWith('/') && !value.startsWith('//')
  if (!local && !/^https?:\/\//i.test(value)) return undefined
  try {
    const url = new URL(value, 'https://www.useaiki.xyz')
    if (url.username || url.password) return undefined
    if (local || ['useaiki.xyz', 'www.useaiki.xyz'].includes(url.hostname))
      return `${url.pathname}${url.search}${url.hash}`
    return url.href
  } catch {
    return undefined
  }
}

/** A small text-only subset, with no HTML parsing or automatic image requests. */
export function messageInlines(text: string): InlinePart[] {
  const pattern =
    /(!?)\[([^\]\n]+)\]\(([^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*/g
  const parts: InlinePart[] = []
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor)
      parts.push({ kind: 'text', text: text.slice(cursor, match.index), offset: cursor })
    const offset = match.index
    if (match[2] !== undefined) {
      const href = match[1] ? undefined : safeMessageHref(match[3] ?? '')
      parts.push({
        kind: href ? 'link' : 'text',
        text: match[2],
        offset,
        ...(href ? { href } : {}),
      })
    } else if (match[4] !== undefined) parts.push({ kind: 'code', text: match[4], offset })
    else if (match[5] !== undefined || match[6] !== undefined)
      parts.push({ kind: 'strong', text: match[5] ?? match[6] ?? '', offset })
    else parts.push({ kind: 'em', text: match[7] ?? '', offset })
    cursor = offset + match[0].length
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor), offset: cursor })
  return parts
}

export function messageBlocks(text: string): MessageBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MessageBlock[] = []
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? ''
    const offset = index
    if (!line.trim()) {
      index++
      continue
    }
    if (/^\s*```/.test(line)) {
      const content: string[] = []
      index++
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? ''))
        content.push(lines[index++] ?? '')
      index++
      blocks.push({ kind: 'code', text: content.join('\n'), offset })
      continue
    }
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', text: heading[1] ?? '', offset })
      index++
      continue
    }
    const list = /^\s*(?:([-*])|(\d+)[.)])\s+(.+)$/.exec(line)
    if (list) {
      const ordered = Boolean(list[2])
      const items: string[] = []
      while (index < lines.length) {
        const item = /^\s*(?:([-*])|(\d+)[.)])\s+(.+)$/.exec(lines[index] ?? '')
        if (!item || Boolean(item[2]) !== ordered) break
        items.push(item[3] ?? '')
        index++
      }
      blocks.push({ kind: 'list', ordered, start: Number(list[2] ?? 1), items, offset })
      continue
    }
    const paragraph = [line]
    index++
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (!next.trim() || /^\s*(?:```|#{1,6}\s|[-*]\s|\d+[.)]\s)/.test(next)) break
      paragraph.push(next)
      index++
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n'), offset })
  }
  return blocks
}
