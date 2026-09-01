'use client'

import { useRouter } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_BG, AGENTS } from '@/lib/agents'
import { useEscapeLayer } from '@/lib/escape'
import { agentHref, FAST_HOME, route } from '@/lib/routes'
import { rankTask, TASKS } from '@/lib/tasks'
import { useModeNavigation } from './prefs'

interface Item {
  id: string
  group: string
  label: string
  sub?: string
  glyph?: string
  bg?: string
  run: () => void
}

const DESTINATIONS = [
  {
    label: 'Fast mode',
    sub: 'One question, full screen',
    href: FAST_HOME,
    glyph: '⌂',
    keys: ['home', 'fast', 'ask', 'start'],
  },
  {
    label: 'Explore',
    sub: 'Every agent we index',
    href: '/explore',
    glyph: '⌕',
    keys: ['explore', 'browse', 'find', 'search', 'agents'],
  },
  {
    label: 'Registry',
    sub: 'Every agent we index, and what we measured',
    href: '/registry',
    glyph: '▤',
    keys: ['registry', 'indexed', 'measured', 'evidence', 'erc8004', 'chain'],
  },
  {
    label: 'Manual mode',
    sub: 'Browse the market yourself',
    href: '/market',
    glyph: '▤',
    keys: ['manual', 'market', 'cards', 'browse'],
  },
  {
    label: 'My agents',
    sub: 'What is working for you',
    href: '/agents',
    glyph: '▣',
    keys: ['my', 'mine', 'hired', 'working'],
  },
  {
    label: 'Activity',
    sub: 'Everything they did',
    href: '/activity',
    glyph: '≡',
    keys: ['activity', 'history', 'log', 'events'],
  },
  {
    label: 'Compare',
    sub: 'Two agents, side by side',
    href: '/compare?agents=guardian,sentinel',
    glyph: '⇄',
    keys: ['compare', 'versus', 'vs'],
  },
  {
    label: 'Docs',
    sub: 'How it works, and how to build on it',
    href: '/docs/getting-started',
    glyph: '⌗',
    keys: ['docs', 'help', 'how', 'test', 'evidence', 'probe', 'method', 'proof', 'mcp', 'api'],
  },
  {
    label: 'Settings',
    sub: 'Wallet, notifications, mode',
    href: '/settings',
    glyph: '⚙',
    keys: ['settings', 'wallet', 'mode', 'preferences'],
  },
]

const score = (keys: string[], label: string, q: string) => {
  const n = q.toLowerCase()
  if (!n) return 1
  if (label.toLowerCase().startsWith(n)) return 4
  if (label.toLowerCase().includes(n)) return 3
  return keys.some((k) => k.startsWith(n)) ? 2 : 0
}

/**
 * ⌘K, and the same intent field as the ask page.
 *
 * The last item is always "ask AiKi" with whatever you typed, so a query the
 * palette cannot resolve still goes somewhere useful instead of dead-ending in
 * an empty list. Nothing here is a search over content — it is navigation, and
 * pretending otherwise would make it slower to trust.
 */
const PaletteCtx = createContext<() => void>(() => {})

/** Lets the sidebar's search button open the same surface ⌘K opens. */
export const usePalette = () => useContext(PaletteCtx)

export function PaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const { switchMode } = useModeNavigation()

  const openPalette = useCallback(() => setOpen(true), [])

  const close = useCallback(() => {
    setOpen(false)
    setQ('')
    setCursor(0)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEscapeLayer(open, close)

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []

    for (const d of DESTINATIONS) {
      if (score(d.keys, d.label, q) > 0) {
        out.push({
          id: `go:${d.href}`,
          group: 'Go to',
          label: d.label,
          sub: d.sub,
          glyph: d.glyph,
          run: () => {
            if (d.href === FAST_HOME) switchMode('fast')
            else if (d.href === '/market') switchMode('manual')
            else router.push(route(d.href))
          },
        })
      }
    }

    for (const a of AGENTS) {
      if (score([a.key, a.does.toLowerCase()], a.name, q) > 0) {
        out.push({
          id: `agent:${a.key}`,
          group: 'Agents',
          label: a.name,
          sub: a.does,
          glyph: a.initial,
          bg: AGENT_BG[a.key] ?? '#171715',
          run: () => router.push(agentHref(a.key)),
        })
      }
    }

    for (const t of TASKS) {
      if (q && rankTask(t, q) > 0) {
        out.push({
          id: `task:${t.key}`,
          group: 'Work AiKi can do',
          label: t.title,
          sub: t.sub,
          glyph: t.glyph,
          bg: t.bg,
          run: () => router.push(route(`/explore?q=${encodeURIComponent(t.intent)}`)),
        })
      }
    }

    if (q.trim()) {
      out.push({
        id: 'ask',
        group: 'Ask',
        label: `Ask AiKi for “${q.trim()}”`,
        sub: 'Searches agents, and logs it if nothing can do it',
        glyph: '→',
        run: () => router.push(route(`/explore?q=${encodeURIComponent(q.trim())}`)),
      })
    }

    return out
  }, [q, router, switchMode])

  // Clamp rather than reset, so typing does not throw the cursor to the top.
  const active = Math.min(cursor, Math.max(items.length - 1, 0))

  const groups = [...new Set(items.map((i) => i.group))]

  return (
    <PaletteCtx.Provider value={openPalette}>
      {children}
      {open ? (
        <div className="fixed inset-0 z-100 flex items-start justify-center pt-[12vh]">
          {/* A real button rather than a click handler on a div, so dismissing
              works from the keyboard and screen readers announce it. */}
          <button
            type="button"
            aria-label="Close the command palette"
            onClick={close}
            className="absolute inset-0 cursor-default border-0 bg-[rgb(26_26_25_/_0.28)]"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="animate-rise relative w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-[20px] bg-white shadow-[0_40px_90px_-30px_rgb(26_26_25_/_0.5)]"
          >
            <div className="flex items-center gap-[11px] border-b border-[rgb(26_26_25_/_0.07)] px-[18px] py-[15px]">
              <span className="relative size-[16px] flex-none rounded-full border-[1.8px] border-[#6B6B66]">
                <span className="absolute -right-[5px] -bottom-1 h-[1.8px] w-[7px] rotate-45 rounded-[2px] bg-[#6B6B66]" />
              </span>
              <input
                ref={input}
                value={q}
                placeholder="Go anywhere, or say what you need done"
                aria-label="Command palette"
                onChange={(e) => {
                  setQ(e.target.value)
                  setCursor(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setCursor((c) => Math.min(c + 1, items.length - 1))
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setCursor((c) => Math.max(c - 1, 0))
                  }
                  if (e.key === 'Enter') {
                    items[active]?.run()
                    close()
                  }
                }}
                className="w-full border-0 bg-none text-[16px] font-medium outline-none placeholder:text-[#A6A6A0]"
              />
              <span className="text-muted flex-none rounded-[7px] bg-[rgb(26_26_25_/_0.05)] px-[7px] py-[4px] text-[11px] font-bold">
                ESC
              </span>
            </div>

            <div className="max-h-[46vh] overflow-y-auto py-[6px]">
              {items.length === 0 ? (
                <div className="text-muted px-[18px] py-[18px] text-[13px]">
                  Nothing matches that.
                </div>
              ) : (
                groups.map((g) => (
                  <div key={g}>
                    <div className="text-muted-3 px-[18px] pt-[10px] pb-[5px] text-[11.5px] font-semibold">
                      {g}
                    </div>
                    {items
                      .filter((i) => i.group === g)
                      .map((i) => {
                        const on = items.indexOf(i) === active
                        return (
                          <button
                            key={i.id}
                            type="button"
                            onMouseEnter={() => setCursor(items.indexOf(i))}
                            onClick={() => {
                              i.run()
                              close()
                            }}
                            className="flex w-full items-center gap-[12px] border-0 px-[18px] py-[9px] text-left"
                            style={{ background: on ? 'rgb(26 26 25 / 0.05)' : 'transparent' }}
                          >
                            <span
                              className="flex size-[28px] flex-none items-center justify-center rounded-[9px] text-[12px] font-extrabold"
                              style={
                                i.bg
                                  ? { background: i.bg, color: '#fff' }
                                  : {
                                      background: 'rgb(26 26 25 / 0.05)',
                                      color: 'var(--color-muted)',
                                    }
                              }
                            >
                              {i.glyph}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13.5px] font-semibold">
                                {i.label}
                              </span>
                              {i.sub ? (
                                <span className="text-muted mt-px block truncate text-[12px]">
                                  {i.sub}
                                </span>
                              ) : null}
                            </span>
                            {on ? (
                              <span className="text-muted flex-none rounded-[7px] bg-white px-[7px] py-[4px] text-[10.5px] font-bold">
                                ↵
                              </span>
                            ) : null}
                          </button>
                        )
                      })}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </PaletteCtx.Provider>
  )
}
