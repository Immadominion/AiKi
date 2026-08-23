'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { useMock } from '@/mock/store'

const PREFERENCE_CHANGE = 'aiki:preference-change'

interface PreferenceChange {
  key: string
  value: string
}

/**
 * Per-browser preferences.
 *
 * Read defensively and written the same way: a private window, cleared site data
 * or a browser set to block storage all make these throw, and the app has to
 * render correctly with no stored value at all. None of this is data worth
 * keeping — it is convenience, and convenience that breaks the page is not.
 */
function usePersisted<T extends string>(key: string, fallback: T, valid: readonly T[]) {
  const [value, setValue] = useState<T>(fallback)
  // Storage is only readable on the client, so the first client render has to
  // match the server's. `ready` lets a caller show that it does not know yet
  // rather than flashing the wrong answer and correcting it.
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const read = () => {
      try {
        const stored = localStorage.getItem(key)
        setValue(stored && (valid as readonly string[]).includes(stored) ? (stored as T) : fallback)
      } catch {
        /* no stored value is a valid state */
      }
    }

    const onPreferenceChange = (event: Event) => {
      const change = (event as CustomEvent<PreferenceChange>).detail
      if (change?.key === key && (valid as readonly string[]).includes(change.value)) {
        setValue(change.value as T)
      }
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return
      const next = event.newValue
      setValue(next && (valid as readonly string[]).includes(next) ? (next as T) : fallback)
    }

    read()
    setReady(true)
    window.addEventListener(PREFERENCE_CHANGE, onPreferenceChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(PREFERENCE_CHANGE, onPreferenceChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [fallback, key, valid])

  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, next)
      } catch {
        /* a preference is never a requirement */
      }
      window.dispatchEvent(
        new CustomEvent<PreferenceChange>(PREFERENCE_CHANGE, { detail: { key, value: next } }),
      )
    },
    [key],
  )

  return [value, set, ready] as const
}

export type HomeLayout = 'fast' | 'manual'
const LAYOUTS = ['fast', 'manual'] as const

export function useLayoutPref() {
  const [layout, setLayout] = usePersisted<HomeLayout>('aiki.home-layout', 'fast', LAYOUTS)
  return { layout, setLayout }
}

/** A mode change replaces the current home instead of leaving route and preference split. */
export function useModeNavigation() {
  const { layout, setLayout } = useLayoutPref()
  const router = useRouter()

  const switchMode = useCallback(
    (next: HomeLayout) => {
      setLayout(next)
      router.replace(next === 'fast' ? '/' : '/market')
    },
    [router, setLayout],
  )

  return { layout, switchMode }
}

/**
 * Wallet connection, delegated to the mock store so the app has exactly one
 * answer to "is anything connected". When apps/api lands this is the hook that
 * changes; nothing that calls it does.
 */
export function useAccount() {
  const { state, ready, connect, disconnect } = useMock()
  return { connected: state.connected, ready, connect, disconnect }
}

const TOUR = ['pending', 'done'] as const

/**
 * Each mode gets its own walkthrough.
 *
 * Fast mode and Manual mode are different products wearing the same brand, and
 * a tour of one teaches you nothing about the other. Choosing Manual at the end
 * of the Fast tour hands you straight to Manual's, rather than dropping you in
 * a layout nobody has explained.
 */
export function useTour(mode: 'fast' | 'manual' = 'fast') {
  const key = mode === 'fast' ? 'aiki.tour.fast' : 'aiki.tour.manual'
  const [state, setState, ready] = usePersisted<'pending' | 'done'>(key, 'pending', TOUR)
  return {
    seen: !ready || state === 'done',
    finish: () => setState('done'),
    replay: () => setState('pending'),
  }
}

const SIDEBAR = ['open', 'closed'] as const

/**
 * Below this the sidebar is a drawer and the ask page drops its decoration.
 * Matches Tailwind's `md`, so the CSS and the JS never disagree about where the
 * layout changes.
 */
export const PHONE_MAX = 767

export function useIsPhone() {
  const [phone, setPhone] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${PHONE_MAX}px)`)
    const sync = () => setPhone(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  return phone
}

/**
 * Agents you have saved.
 *
 * Kept in this browser rather than on a server: saving is a private act of
 * interest in something, and shipping it anywhere would make it a signal about
 * you. Reads and writes are guarded the same way as every other preference.
 */
const SAVED_KEY = 'aiki.saved'

export function useSaved() {
  const [saved, setSaved] = useState<string[]>([])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) setSaved(parsed.filter((x): x is string => typeof x === 'string'))
    } catch {
      /* nothing saved is a valid state */
    }
  }, [])

  const toggle = useCallback((key: string) => {
    let next: string[] = []
    setSaved((prev) => {
      next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      try {
        localStorage.setItem(SAVED_KEY, JSON.stringify(next))
      } catch {
        /* a save is a convenience, never a requirement */
      }
      return next
    })
  }, [])

  return { saved, toggle, isSaved: (key: string) => saved.includes(key) }
}

export function useSidebar() {
  const [state, setState] = usePersisted<'open' | 'closed'>('aiki.sidebar', 'open', SIDEBAR)
  const collapsed = state === 'closed'
  return { collapsed, toggle: () => setState(collapsed ? 'open' : 'closed') }
}
